import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { OverdueBadge } from '../components/LoanBadges';
import { entryLabel, fetchReferenceList, type ReferenceEntry } from '../components/ReferenceContextFields';
import { thaiDate } from '../components/assignmentFacts';
import { LOAN_STATUS_LABELS, borrowerText, loanStatusText, voidedStyle, type Borrower, type LoanListRow, type LoanStatus } from '../components/loanFacts';

const PAGE_SIZE = 25;

const LOAD_ERRORS: Record<number, string> = {
  403: 'คุณไม่มีสิทธิ์เข้าถึงรายการยืม (403 Forbidden)',
};

// The filters a list is read with, as the URL holds them; '' is no filter.
interface Filters {
  status: '' | LoanStatus;
  overdue: boolean;
  borrower_kind: '' | Borrower['kind'];
  borrower_person_id: string;
  borrower_name: string;
}

const filtersOf = (params: URLSearchParams): Filters => ({
  status: (params.get('status') ?? '') as Filters['status'],
  overdue: params.get('overdue') === 'true',
  borrower_kind: (params.get('borrower_kind') ?? '') as Filters['borrower_kind'],
  borrower_person_id: params.get('borrower_person_id') ?? '',
  borrower_name: params.get('borrower_name') ?? '',
});

// The URL of a list: only the filters given, and a Person entry or a name only with its Borrower kind.
const paramsOf = (filters: Filters, offset: number): URLSearchParams => {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.overdue) params.set('overdue', 'true');
  if (filters.borrower_kind) params.set('borrower_kind', filters.borrower_kind);
  if (filters.borrower_kind === 'INTERNAL' && filters.borrower_person_id) params.set('borrower_person_id', filters.borrower_person_id);
  if (filters.borrower_kind === 'EXTERNAL' && filters.borrower_name.trim()) params.set('borrower_name', filters.borrower_name.trim());
  if (offset > 0) params.set('offset', String(offset));
  return params;
};

interface LoanListPage {
  items: LoanListRow[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: '0.875rem', fontWeight: 500, color: '#374151', marginBottom: '0.25rem' };
const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '0.5rem 0.75rem',
  borderRadius: '4px',
  border: '1px solid #d1d5db',
  fontSize: '0.875rem',
  backgroundColor: '#ffffff',
};
const cellStyle: React.CSSProperties = { padding: '0.75rem 1rem', color: '#111827', verticalAlign: 'top' };
const headStyle: React.CSSProperties = { padding: '0.75rem 1rem', fontWeight: 600, color: '#374151' };
const pageButtonStyle = (disabled: boolean): React.CSSProperties => ({
  padding: '0.375rem 0.75rem',
  backgroundColor: disabled ? '#f3f4f6' : '#ffffff',
  color: disabled ? '#9ca3af' : '#374151',
  border: '1px solid #d1d5db',
  borderRadius: '4px',
  fontSize: '0.875rem',
  cursor: disabled ? 'not-allowed' : 'pointer',
});

const LoanListContent: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.toString();
  const applied = filtersOf(searchParams);
  const offset = Number(searchParams.get('offset') ?? 0) || 0;

  // What the form shows until it is submitted; a new URL, such as going back, shows that URL's filters.
  const [draft, setDraft] = useState<Filters>(applied);
  useEffect(() => {
    setDraft(filtersOf(new URLSearchParams(query)));
  }, [query]);

  const loans = useQuery<LoanListPage, Error & { status?: number }>({
    queryKey: ['loans', query],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams(query);
      params.set('limit', String(PAGE_SIZE));
      const res = await fetch(`/loans?${params.toString()}`, { credentials: 'include', signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
  });

  // Deactivated entries too: a Borrower who has left stays on their Loans (#74 Q7).
  const persons = useQuery<ReferenceEntry[]>({
    queryKey: ['loan-list-persons'],
    queryFn: async ({ signal }) => {
      const list = await fetchReferenceList('persons', true, signal);
      if (!list.ok) {
        throw new Error(`HTTP ${list.status}`);
      }
      return list.items;
    },
    enabled: draft.borrower_kind === 'INTERNAL',
  });

  const isSignedOut = loans.error?.status === 401;
  useEffect(() => {
    if (isSignedOut) {
      navigate('/login', { replace: true });
    }
  }, [isSignedOut, navigate]);

  const show = (filters: Filters, nextOffset: number) => setSearchParams(paramsOf(filters, nextOffset));
  const setDraftField = <K extends keyof Filters>(field: K, value: Filters[K]) => setDraft((current) => ({ ...current, [field]: value }));

  // A failed read hides what an earlier one showed: a lost grant fails closed.
  const page = loans.isError ? undefined : loans.data;
  const isForbidden = loans.error?.status === 403;

  return (
    <main style={{ minHeight: '100vh', backgroundColor: '#f3f4f6', padding: '2rem 1rem', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <div style={{ maxWidth: '1000px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1)', padding: '2rem' }}>
        <Link to="/dashboard" id="back-dashboard-link" style={{ color: '#4b5563', textDecoration: 'none', fontSize: '0.875rem', fontWeight: 500 }}>
          ← กลับสู่แดชบอร์ด
        </Link>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: '1rem 0 1.5rem 0' }}>รายการยืม</h1>

        {loans.isError && !isSignedOut && (
          <div role="alert" id="loan-list-error" style={{ padding: '0.75rem 1rem', marginBottom: '1.5rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            {LOAD_ERRORS[loans.error.status ?? 0] ?? 'เกิดข้อผิดพลาดในการโหลดรายการยืม'}{' '}
            {!isForbidden && (
              <button type="button" id="loan-list-retry" onClick={() => loans.refetch()}>
                ลองใหม่
              </button>
            )}
          </div>
        )}
        {!isForbidden && (
          <>
            <form
              id="loan-list-form"
              onSubmit={(e) => {
                e.preventDefault();
                show(draft, 0);
              }}
              style={{ backgroundColor: '#f9fafb', padding: '1.25rem', borderRadius: '6px', marginBottom: '1.5rem', border: '1px solid #e5e7eb' }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', alignItems: 'flex-end' }}>
                <div>
                  <label htmlFor="loan-filter-status" style={labelStyle}>
                    สถานะ
                  </label>
                  <select id="loan-filter-status" value={draft.status} onChange={(e) => setDraftField('status', e.target.value as Filters['status'])} style={inputStyle}>
                    <option value="">ทั้งหมด</option>
                    {(Object.keys(LOAN_STATUS_LABELS) as LoanStatus[]).map((status) => (
                      <option key={status} value={status}>
                        {LOAN_STATUS_LABELS[status]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="loan-filter-borrower_kind" style={labelStyle}>
                    ผู้ยืม
                  </label>
                  <select
                    id="loan-filter-borrower_kind"
                    value={draft.borrower_kind}
                    onChange={(e) => setDraftField('borrower_kind', e.target.value as Filters['borrower_kind'])}
                    style={inputStyle}
                  >
                    <option value="">ทั้งหมด</option>
                    <option value="INTERNAL">ผู้ยืมภายใน</option>
                    <option value="EXTERNAL">ผู้ยืมภายนอก</option>
                  </select>
                </div>
                {draft.borrower_kind === 'INTERNAL' && (
                  <div>
                    <label htmlFor="loan-filter-borrower_person_id" style={labelStyle}>
                      ผู้ยืมภายใน
                    </label>
                    <select
                      id="loan-filter-borrower_person_id"
                      value={draft.borrower_person_id}
                      onChange={(e) => setDraftField('borrower_person_id', e.target.value)}
                      style={inputStyle}
                    >
                      <option value="">ทั้งหมด</option>
                      {(persons.data ?? []).map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entryLabel(entry)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {draft.borrower_kind === 'EXTERNAL' && (
                  <div>
                    <label htmlFor="loan-filter-borrower_name" style={labelStyle}>
                      ชื่อผู้ติดต่อหรือหน่วยงาน
                    </label>
                    <input
                      id="loan-filter-borrower_name"
                      type="text"
                      value={draft.borrower_name}
                      // A contact or organization name is at most 200 characters (#75).
                      maxLength={200}
                      onChange={(e) => setDraftField('borrower_name', e.target.value)}
                      style={inputStyle}
                    />
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
                <label htmlFor="loan-filter-overdue" style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.875rem', fontWeight: 500, color: '#374151' }}>
                  <input id="loan-filter-overdue" type="checkbox" checked={draft.overdue} onChange={(e) => setDraftField('overdue', e.target.checked)} />
                  เกินกำหนด
                </label>
                <button
                  type="submit"
                  id="loan-list-submit"
                  style={{ padding: '0.5rem 1.25rem', backgroundColor: '#2563eb', color: '#ffffff', border: 'none', borderRadius: '4px', fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer' }}
                >
                  ค้นหา
                </button>
                <button
                  type="button"
                  id="loan-list-reset"
                  onClick={() => setSearchParams(new URLSearchParams())}
                  style={{ padding: '0.5rem 1rem', backgroundColor: '#ffffff', color: '#4b5563', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer' }}
                >
                  รีเซ็ต
                </button>
              </div>
              {persons.isError && draft.borrower_kind === 'INTERNAL' && (
                <div role="alert" style={{ marginTop: '0.5rem', fontSize: '0.8125rem', color: '#b91c1c' }}>
                  ไม่สามารถโหลดรายการบุคคลได้
                </div>
              )}
            </form>

            {loans.isPending && (
              <div role="status" aria-busy="true" style={{ padding: '2rem', textAlign: 'center', color: '#6b7280', fontSize: '0.875rem' }}>
                กำลังโหลดรายการยืม...
              </div>
            )}
            {page && (
              <section aria-label="รายการยืม" id="loan-list-region">
                <div id="loan-list-count" style={{ marginBottom: '1rem', fontSize: '0.875rem', color: '#6b7280' }}>
                  {page.total_count > 0
                    ? `พบ ${page.total_count} รายการ (แสดง ${page.offset + 1} - ${Math.min(page.offset + page.items.length, page.total_count)})`
                    : 'ไม่พบรายการ'}
                </div>
                {page.items.length === 0 ? (
                  <div
                    id="loan-list-empty"
                    style={{ padding: '3rem 1rem', textAlign: 'center', backgroundColor: '#f9fafb', borderRadius: '6px', border: '1px dashed #d1d5db', color: '#6b7280', fontSize: '0.9375rem' }}
                  >
                    ไม่พบการยืมตามเงื่อนไขที่ระบุ
                  </div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table id="loan-list-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.875rem' }}>
                      <thead>
                        <tr style={{ backgroundColor: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                          <th style={headStyle}>ผู้ยืม</th>
                          <th style={headStyle}>วันที่ยืม</th>
                          <th style={headStyle}>รายการ</th>
                          <th style={headStyle}>สถานะ</th>
                          <th style={headStyle}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {page.items.map((loan) => (
                          <tr key={loan.id} data-testid={`loan-row-${loan.id}`} style={{ borderBottom: '1px solid #e5e7eb', ...(loan.is_voided ? voidedStyle : {}) }}>
                            <td style={{ ...cellStyle, fontWeight: 500 }}>{borrowerText(loan.borrower)}</td>
                            <td style={cellStyle}>
                              <time dateTime={loan.loan_date}>{thaiDate(loan.loan_date)}</time>
                            </td>
                            <td style={cellStyle}>
                              คืนแล้ว {loan.returned_count} จาก {loan.item_count} รายการ
                            </td>
                            <td style={cellStyle}>
                              {loanStatusText(loan.status, loan.not_returned_count)}
                              {loan.is_overdue && <OverdueBadge />}
                            </td>
                            <td style={cellStyle}>
                              <Link to={`/loans/${loan.id}`} style={{ color: '#2563eb', textDecoration: 'underline' }}>
                                ดูการยืม
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {page.total_count > PAGE_SIZE && (
                  <div id="loan-list-pagination" style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '0.75rem', marginTop: '1.5rem' }}>
                    <button type="button" id="loan-list-prev" disabled={offset === 0} onClick={() => show(applied, Math.max(0, offset - PAGE_SIZE))} style={pageButtonStyle(offset === 0)}>
                      ← ก่อนหน้า
                    </button>
                    <span id="loan-list-page" style={{ fontSize: '0.875rem', color: '#4b5563' }}>
                      หน้า {Math.floor(page.offset / PAGE_SIZE) + 1} จาก {Math.ceil(page.total_count / PAGE_SIZE)}
                    </span>
                    <button type="button" id="loan-list-next" disabled={!page.has_more} onClick={() => show(applied, offset + PAGE_SIZE)} style={pageButtonStyle(!page.has_more)}>
                      ถัดไป →
                    </button>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
};

/** The Loan list ("รายการยืม", F004-T3): who holds what, and what is late. */
export const LoanList: React.FC = () => {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <LoanListContent />
    </QueryClientProvider>
  );
};
