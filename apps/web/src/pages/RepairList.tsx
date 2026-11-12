import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { thaiDate } from '../components/assignmentFacts';
import { VoidedMark } from '../components/LoanBadges';
import { RepairConflictMarks } from '../components/RepairConflicts';
import { assetLabel, voidedStyle } from '../components/loanFacts';
import {
  OUTCOME_DATE_LABEL,
  REPAIRER_KIND_LABELS,
  REPAIR_CONFLICT_FILTER_LABEL,
  REPAIR_KIND_LABELS,
  REPAIR_LIST_LABEL,
  REPAIR_OUTCOME_LABELS,
  UNDER_REPAIR_LABELS,
  repairerText,
  type RepairKind,
  type RepairListPage,
  type RepairOutcomeValue,
  type RepairerKind,
} from '../components/repairFacts';

const PAGE_SIZE = 25;

const LOAD_ERRORS: Record<number, string> = {
  403: 'คุณไม่มีสิทธิ์เข้าถึงรายการซ่อม/บำรุงรักษา (403 Forbidden)',
};

// The filters a list is read with, as the URL holds them; '' is no filter.
interface Filters {
  has_outcome: '' | 'true' | 'false';
  repair_kind: '' | RepairKind;
  outcome: '' | RepairOutcomeValue;
  repairer_kind: '' | RepairerKind;
  has_repair_conflict: boolean;
  search: string;
}

const filtersOf = (params: URLSearchParams): Filters => ({
  has_outcome: (params.get('has_outcome') ?? '') as Filters['has_outcome'],
  repair_kind: (params.get('repair_kind') ?? '') as Filters['repair_kind'],
  outcome: (params.get('outcome') ?? '') as Filters['outcome'],
  repairer_kind: (params.get('repairer_kind') ?? '') as Filters['repairer_kind'],
  has_repair_conflict: params.get('has_repair_conflict') === 'true',
  search: params.get('search') ?? '',
});

// The URL of a list: only the filters given.
const paramsOf = (filters: Filters, offset: number): URLSearchParams => {
  const params = new URLSearchParams();
  if (filters.has_outcome) params.set('has_outcome', filters.has_outcome);
  if (filters.repair_kind) params.set('repair_kind', filters.repair_kind);
  if (filters.outcome) params.set('outcome', filters.outcome);
  if (filters.repairer_kind) params.set('repairer_kind', filters.repairer_kind);
  if (filters.has_repair_conflict) params.set('has_repair_conflict', 'true');
  if (filters.search.trim()) params.set('search', filters.search.trim());
  if (offset > 0) params.set('offset', String(offset));
  return params;
};

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

const RepairListContent: React.FC = () => {
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

  const repairs = useQuery<RepairListPage, Error & { status?: number }>({
    queryKey: ['repairs', query],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams(query);
      params.set('limit', String(PAGE_SIZE));
      const res = await fetch(`/repairs?${params.toString()}`, { credentials: 'include', signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
  });

  const isSignedOut = repairs.error?.status === 401;
  useEffect(() => {
    if (isSignedOut) {
      navigate('/login', { replace: true });
    }
  }, [isSignedOut, navigate]);

  const show = (filters: Filters, nextOffset: number) => setSearchParams(paramsOf(filters, nextOffset));
  const setDraftField = <K extends keyof Filters>(field: K, value: Filters[K]) => setDraft((current) => ({ ...current, [field]: value }));

  // A failed read hides what an earlier one showed: a lost grant fails closed.
  const page = repairs.isError ? undefined : repairs.data;
  const isForbidden = repairs.error?.status === 403;

  return (
    <main style={{ minHeight: '100vh', backgroundColor: '#f3f4f6', padding: '2rem 1rem', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <div style={{ maxWidth: '1000px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1)', padding: '2rem' }}>
        <Link to="/dashboard" id="back-dashboard-link" style={{ color: '#4b5563', textDecoration: 'none', fontSize: '0.875rem', fontWeight: 500 }}>
          ← กลับสู่แดชบอร์ด
        </Link>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: '1rem 0 1.5rem 0' }}>{REPAIR_LIST_LABEL}</h1>

        {repairs.isError && !isSignedOut && (
          <div role="alert" id="repair-list-error" style={{ padding: '0.75rem 1rem', marginBottom: '1.5rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            {LOAD_ERRORS[repairs.error.status ?? 0] ?? 'เกิดข้อผิดพลาดในการโหลดรายการซ่อม/บำรุงรักษา'}{' '}
            {!isForbidden && (
              <button type="button" id="repair-list-retry" onClick={() => repairs.refetch()}>
                ลองใหม่
              </button>
            )}
          </div>
        )}
        {!isForbidden && (
          <>
            <form
              id="repair-list-form"
              onSubmit={(e) => {
                e.preventDefault();
                show(draft, 0);
              }}
              style={{ backgroundColor: '#f9fafb', padding: '1.25rem', borderRadius: '6px', marginBottom: '1.5rem', border: '1px solid #e5e7eb' }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', alignItems: 'flex-end' }}>
                <div>
                  <label htmlFor="repair-filter-has_outcome" style={labelStyle}>
                    สถานะ
                  </label>
                  <select
                    id="repair-filter-has_outcome"
                    value={draft.has_outcome}
                    onChange={(e) => setDraftField('has_outcome', e.target.value as Filters['has_outcome'])}
                    style={inputStyle}
                  >
                    <option value="">ทั้งหมด</option>
                    <option value="false">อยู่ระหว่างซ่อม/บำรุงรักษา</option>
                    <option value="true">มีผลการซ่อมแล้ว</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="repair-filter-repair_kind" style={labelStyle}>
                    ประเภท
                  </label>
                  <select
                    id="repair-filter-repair_kind"
                    value={draft.repair_kind}
                    onChange={(e) => setDraftField('repair_kind', e.target.value as Filters['repair_kind'])}
                    style={inputStyle}
                  >
                    <option value="">ทั้งหมด</option>
                    {(Object.keys(REPAIR_KIND_LABELS) as RepairKind[]).map((kind) => (
                      <option key={kind} value={kind}>
                        {REPAIR_KIND_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="repair-filter-outcome" style={labelStyle}>
                    ผลการซ่อม
                  </label>
                  <select id="repair-filter-outcome" value={draft.outcome} onChange={(e) => setDraftField('outcome', e.target.value as Filters['outcome'])} style={inputStyle}>
                    <option value="">ทั้งหมด</option>
                    <option value="USABLE">{REPAIR_OUTCOME_LABELS.REPAIR.USABLE}</option>
                    <option value="NOT_USABLE">{`${REPAIR_OUTCOME_LABELS.REPAIR.NOT_USABLE} / ${REPAIR_OUTCOME_LABELS.MAINTENANCE.NOT_USABLE}`}</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="repair-filter-repairer_kind" style={labelStyle}>
                    ผู้ซ่อม
                  </label>
                  <select
                    id="repair-filter-repairer_kind"
                    value={draft.repairer_kind}
                    onChange={(e) => setDraftField('repairer_kind', e.target.value as Filters['repairer_kind'])}
                    style={inputStyle}
                  >
                    <option value="">ทั้งหมด</option>
                    {(Object.keys(REPAIRER_KIND_LABELS) as RepairerKind[]).map((kind) => (
                      <option key={kind} value={kind}>
                        {REPAIRER_KIND_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="repair-filter-search" style={labelStyle}>
                    ชื่อผู้ซ่อมหรืออาการ/งานที่ทำ
                  </label>
                  <input
                    id="repair-filter-search"
                    type="text"
                    value={draft.search}
                    // The server takes a search of at most 4096 bytes, which holds 1365 Thai characters.
                    maxLength={1000}
                    onChange={(e) => setDraftField('search', e.target.value)}
                    style={inputStyle}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
                <label htmlFor="repair-filter-has_repair_conflict" style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.875rem', fontWeight: 500, color: '#374151' }}>
                  <input
                    id="repair-filter-has_repair_conflict"
                    type="checkbox"
                    checked={draft.has_repair_conflict}
                    onChange={(e) => setDraftField('has_repair_conflict', e.target.checked)}
                  />
                  {REPAIR_CONFLICT_FILTER_LABEL}
                </label>
                <button
                  type="submit"
                  id="repair-list-submit"
                  style={{ padding: '0.5rem 1.25rem', backgroundColor: '#2563eb', color: '#ffffff', border: 'none', borderRadius: '4px', fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer' }}
                >
                  ค้นหา
                </button>
                <button
                  type="button"
                  id="repair-list-reset"
                  onClick={() => setSearchParams(new URLSearchParams())}
                  style={{ padding: '0.5rem 1rem', backgroundColor: '#ffffff', color: '#4b5563', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer' }}
                >
                  รีเซ็ต
                </button>
              </div>
            </form>

            {repairs.isPending && (
              <div role="status" aria-busy="true" style={{ padding: '2rem', textAlign: 'center', color: '#6b7280', fontSize: '0.875rem' }}>
                กำลังโหลดรายการซ่อม/บำรุงรักษา...
              </div>
            )}
            {page && (
              <section aria-label={REPAIR_LIST_LABEL} id="repair-list-region">
                <div id="repair-list-count" style={{ marginBottom: '1rem', fontSize: '0.875rem', color: '#6b7280' }}>
                  {page.total_count > 0
                    ? `พบ ${page.total_count} รายการ (แสดง ${page.offset + 1} - ${Math.min(page.offset + page.items.length, page.total_count)})`
                    : 'ไม่พบรายการ'}
                </div>
                {page.items.length === 0 ? (
                  <div
                    id="repair-list-empty"
                    style={{ padding: '3rem 1rem', textAlign: 'center', backgroundColor: '#f9fafb', borderRadius: '6px', border: '1px dashed #d1d5db', color: '#6b7280', fontSize: '0.9375rem' }}
                  >
                    ไม่พบรายการซ่อม/บำรุงรักษาตามเงื่อนไขที่ระบุ
                  </div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table id="repair-list-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.875rem' }}>
                      <thead>
                        <tr style={{ backgroundColor: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                          <th style={headStyle}>ครุภัณฑ์</th>
                          <th style={headStyle}>ประเภท</th>
                          <th style={headStyle}>วันที่ส่งซ่อม</th>
                          <th style={headStyle}>ผู้ซ่อม</th>
                          <th style={headStyle}>ผลการซ่อม</th>
                          <th style={headStyle}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {page.items.map((record) => (
                          // A voided record stays listed, struck through, and counts in nothing (#98 Q18).
                          <tr key={record.id} data-testid={`repair-row-${record.id}`} style={{ borderBottom: '1px solid #e5e7eb', ...(record.is_voided ? voidedStyle : {}) }}>
                            <td style={{ ...cellStyle, fontWeight: 500 }}>
                              <Link to={`/assets/${record.asset.id}`} style={{ color: '#2563eb', textDecoration: 'underline' }}>
                                {assetLabel(record.asset)}
                              </Link>
                              {record.asset.asset_number && record.asset.name && <span style={{ color: '#6b7280', fontWeight: 400 }}> ({record.asset.asset_number})</span>}
                              <div style={{ color: '#4b5563', fontWeight: 400, marginTop: '0.25rem', whiteSpace: 'pre-line' }}>{record.symptom_or_work}</div>
                            </td>
                            <td style={cellStyle}>{REPAIR_KIND_LABELS[record.repair_kind]}</td>
                            <td style={cellStyle}>
                              <time dateTime={record.start_date}>{thaiDate(record.start_date)}</time>
                              <RepairConflictMarks conflicts={record.conflicts} testId={`repair-row-conflicts-${record.id}`} />
                            </td>
                            <td style={cellStyle}>{repairerText(record.repairer)}</td>
                            <td style={cellStyle}>
                              {record.is_voided && <VoidedMark testId={`repair-row-voided-${record.id}`} />}
                              {record.outcome && (
                                <>
                                  {REPAIR_OUTCOME_LABELS[record.repair_kind][record.outcome.outcome]}
                                  <div style={{ color: '#6b7280', marginTop: '0.25rem' }}>
                                    {OUTCOME_DATE_LABEL}: <time dateTime={record.outcome.outcome_date}>{thaiDate(record.outcome.outcome_date)}</time>
                                  </div>
                                </>
                              )}
                              {!record.outcome && !record.is_voided && <span style={{ color: '#92400e', fontWeight: 600 }}>{UNDER_REPAIR_LABELS[record.repair_kind]}</span>}
                              {record.voided_outcomes.map((voided) => (
                                <div key={voided.id} data-testid={`repair-row-voided-outcome-${voided.id}`} style={{ marginTop: '0.25rem' }}>
                                  <span style={voidedStyle}>
                                    {REPAIR_OUTCOME_LABELS[record.repair_kind][voided.outcome]} <time dateTime={voided.outcome_date}>{thaiDate(voided.outcome_date)}</time>
                                  </span>
                                  <VoidedMark testId={`repair-row-voided-outcome-mark-${voided.id}`} />
                                </div>
                              ))}
                            </td>
                            <td style={cellStyle}>
                              <Link to={`/repairs/${record.id}`} style={{ color: '#2563eb', textDecoration: 'underline' }}>
                                ดูรายการ
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {page.total_count > PAGE_SIZE && (
                  <div id="repair-list-pagination" style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '0.75rem', marginTop: '1.5rem' }}>
                    <button type="button" id="repair-list-prev" disabled={offset === 0} onClick={() => show(applied, Math.max(0, offset - PAGE_SIZE))} style={pageButtonStyle(offset === 0)}>
                      ← ก่อนหน้า
                    </button>
                    <span id="repair-list-page" style={{ fontSize: '0.875rem', color: '#4b5563' }}>
                      หน้า {Math.floor(page.offset / PAGE_SIZE) + 1} จาก {Math.ceil(page.total_count / PAGE_SIZE)}
                    </span>
                    <button type="button" id="repair-list-next" disabled={!page.has_more} onClick={() => show(applied, offset + PAGE_SIZE)} style={pageButtonStyle(!page.has_more)}>
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

/** The Repair list ("รายการซ่อม/บำรุงรักษา", F005-T3): what is away for repair or maintenance, and how each job ended. */
export const RepairList: React.FC = () => {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <RepairListContent />
    </QueryClientProvider>
  );
};
