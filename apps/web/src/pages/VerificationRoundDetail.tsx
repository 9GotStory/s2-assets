import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { REFERENCE_DIMENSIONS, entryLabel } from '../components/ReferenceContextFields';
import { thaiDate, valueText } from '../components/assignmentFacts';
import {
  FISCAL_YEAR_LABEL,
  RESULT_LABELS,
  ROUND_EVENT_LABELS,
  ROUND_STATE_LABELS,
  SCOPE_SNAPSHOT_LABEL,
  START_DATE_LABEL,
  VERIFICATION_ROUND_LABEL,
  WHOLE_REGISTER_LABEL,
  type ScopeEntry,
  type ScopeEntryPage,
  type VerificationRound,
} from '../components/verificationFacts';

const PAGE_SIZE = 25;

const THAI_DATE_TIME = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

const LOAD_ERRORS: Record<number, string> = {
  403: 'คุณไม่มีสิทธิ์เข้าถึงรอบตรวจนี้ (403 Forbidden)',
  404: 'ไม่พบรอบตรวจที่ระบุ (404 Not Found)',
};

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  padding: '1rem',
  boxSizing: 'border-box',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  backgroundColor: '#f5f5f5',
};

const cardStyle: React.CSSProperties = {
  maxWidth: '900px',
  margin: '0 auto',
  backgroundColor: '#ffffff',
  borderRadius: '8px',
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
  padding: '1.25rem',
  boxSizing: 'border-box',
};

const termStyle: React.CSSProperties = { fontWeight: 500, color: '#4b5563' };
const valueStyle: React.CSSProperties = { margin: 0, color: '#111827', minWidth: 0, overflowWrap: 'anywhere' };
const sectionHeadingStyle: React.CSSProperties = { fontSize: '1.125rem', fontWeight: 600, color: '#111827', margin: '1.5rem 0 0.75rem 0' };
const pageButtonStyle = (disabled: boolean): React.CSSProperties => ({
  padding: '0.375rem 0.75rem',
  backgroundColor: disabled ? '#f3f4f6' : '#ffffff',
  color: disabled ? '#9ca3af' : '#374151',
  border: '1px solid #d1d5db',
  borderRadius: '4px',
  fontSize: '0.875rem',
  cursor: disabled ? 'not-allowed' : 'pointer',
});

class HttpError extends Error {
  status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

const readJson = async <T,>(url: string, signal: AbortSignal): Promise<T> => {
  const res = await fetch(url, { credentials: 'include', signal });
  if (!res.ok) {
    throw new HttpError(res.status);
  }
  return res.json();
};

// One Asset of the Scope Snapshot as the register showed it when the Round opened (#125 Q4).
const ScopeEntryItem: React.FC<{ entry: ScopeEntry }> = ({ entry }) => {
  const { snapshot } = entry;
  return (
    <li data-testid={`scope-entry-${entry.asset_id}`} style={{ padding: '0.75rem 0', borderBottom: '1px solid #e5e7eb', fontSize: '0.875rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
        <Link to={`/assets/${entry.asset_id}`} style={{ color: '#2563eb', textDecoration: 'underline', fontWeight: 600, overflowWrap: 'anywhere' }}>
          {snapshot.name ?? snapshot.asset_number ?? entry.asset_id}
        </Link>
        <span data-testid={`scope-entry-result-${entry.asset_id}`} style={{ color: '#92400e', fontWeight: 600, whiteSpace: 'nowrap' }}>
          {RESULT_LABELS[entry.result]}
        </span>
      </div>
      <div style={{ color: '#4b5563', marginTop: '0.25rem', overflowWrap: 'anywhere' }}>
        หมายเลขครุภัณฑ์: {snapshot.asset_number ?? '-'} · Serial Number: {snapshot.serial_number ?? '-'}
        {snapshot.category && <> · หมวด: {snapshot.category}</>}
      </div>
      <div data-testid={`scope-entry-assignment-${entry.asset_id}`} style={{ color: '#4b5563', marginTop: '0.25rem', overflowWrap: 'anywhere' }}>
        {REFERENCE_DIMENSIONS.map(({ entryField, legacyField, label }) => (
          <div key={entryField}>
            {label}: {valueText({ entry: snapshot[entryField], legacy_text: snapshot[legacyField] })}
          </div>
        ))}
      </div>
    </li>
  );
};

const VerificationRoundDetailContent: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get('search') ?? '';
  const offset = Number(searchParams.get('offset') ?? 0) || 0;
  // What the search box shows until it is submitted; a new URL, such as going back, shows that URL's search.
  const [draft, setDraft] = useState(search);
  useEffect(() => {
    setDraft(search);
  }, [search]);

  const round = useQuery<VerificationRound, HttpError>({
    queryKey: ['verification-round', id],
    queryFn: ({ signal }) => readJson(`/verification-rounds/${id}`, signal),
  });
  const entries = useQuery<ScopeEntryPage, HttpError>({
    queryKey: ['verification-round-entries', id, search, offset],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (search.trim()) {
        params.set('search', search.trim());
      }
      return readJson(`/verification-rounds/${id}/entries?${params.toString()}`, signal);
    },
    enabled: round.isSuccess,
  });

  const isSignedOut = round.error?.status === 401 || entries.error?.status === 401;
  useEffect(() => {
    if (isSignedOut) {
      navigate('/login', { replace: true });
    }
  }, [isSignedOut, navigate]);

  const show = (nextSearch: string, nextOffset: number) => {
    const params = new URLSearchParams();
    if (nextSearch.trim()) params.set('search', nextSearch.trim());
    if (nextOffset > 0) params.set('offset', String(nextOffset));
    setSearchParams(params);
  };

  // A failed read hides what an earlier one showed: a lost grant fails closed.
  if (round.isError) {
    return (
      <main style={pageStyle}>
        <div style={{ ...cardStyle, textAlign: 'center' }}>
          <div role="alert" id="verification-round-load-error" style={{ padding: '1rem', backgroundColor: '#fee2e2', color: '#991b1b', borderRadius: '6px', marginBottom: '1.5rem', fontWeight: 500 }}>
            {LOAD_ERRORS[round.error.status] ?? 'เกิดข้อผิดพลาดในการโหลดรอบตรวจ'}
          </div>
          <Link to="/verification-rounds" style={{ color: '#2563eb', textDecoration: 'none', fontWeight: 500, fontSize: '0.875rem' }}>
            ← กลับไปยัง{VERIFICATION_ROUND_LABEL}
          </Link>
        </div>
      </main>
    );
  }

  if (!round.data) {
    return (
      <main style={{ ...pageStyle, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        <div role="status" aria-live="polite" style={{ color: '#4b5563' }}>
          กำลังโหลดรอบตรวจ...
        </div>
      </main>
    );
  }

  const { name, fiscal_year: fiscalYear, start_date: startDate, state, notes, filters, counts, opened_by: openedBy, opened_by_username: openedByUsername, recorded_at: recordedAt, history } = round.data;
  const page = entries.isError ? undefined : entries.data;
  const filterText = (label: string, chosen: { id: string; name: string; is_active: boolean }[]) => (chosen.length > 0 ? `${label}: ${chosen.map(entryLabel).join(', ')}` : null);
  const scopeText = [filterText('หน่วยงาน', filters.organization_units), filterText('สถานที่', filters.locations)].filter(Boolean).join(' และ ') || WHOLE_REGISTER_LABEL;

  return (
    <main style={pageStyle}>
      <div style={cardStyle}>
        <Link to="/verification-rounds" id="back-verification-round-list-link" style={{ color: '#4b5563', textDecoration: 'none', fontSize: '0.875rem', fontWeight: 500 }}>
          ← กลับไปยัง{VERIFICATION_ROUND_LABEL}
        </Link>
        <p style={{ margin: '1rem 0 0.25rem 0', fontSize: '0.875rem', color: '#6b7280' }}>{VERIFICATION_ROUND_LABEL}</p>
        <h1 id="verification-round-name" style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: '0 0 1rem 0', overflowWrap: 'anywhere' }}>
          {name}
        </h1>

        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '0.5rem 1rem', margin: 0, fontSize: '0.9375rem' }}>
          <dt style={termStyle}>{FISCAL_YEAR_LABEL}:</dt>
          <dd id="verification-round-fiscal-year" style={valueStyle}>
            {fiscalYear}
          </dd>
          <dt style={termStyle}>{START_DATE_LABEL}:</dt>
          <dd id="verification-round-start-date" style={valueStyle}>
            <time dateTime={startDate}>{thaiDate(startDate)}</time>
          </dd>
          <dt style={termStyle}>สถานะ:</dt>
          <dd id="verification-round-state" style={{ ...valueStyle, fontWeight: 600 }}>
            {ROUND_STATE_LABELS[state]}
          </dd>
          <dt style={termStyle}>ขอบเขต:</dt>
          <dd id="verification-round-scope" style={valueStyle}>
            {scopeText}
          </dd>
          <dt style={termStyle}>หมายเหตุ:</dt>
          <dd id="verification-round-notes" style={{ ...valueStyle, whiteSpace: 'pre-line' }}>
            {notes ?? <span style={{ color: '#9ca3af' }}>ไม่ระบุ</span>}
          </dd>
          <dt style={termStyle}>ผู้เปิดรอบ:</dt>
          <dd id="verification-round-opened-by" style={valueStyle}>
            {openedByUsername ?? openedBy}
          </dd>
          <dt style={termStyle}>วันที่บันทึก:</dt>
          <dd id="verification-round-recorded-at" style={valueStyle}>
            <time dateTime={recordedAt}>{THAI_DATE_TIME.format(new Date(recordedAt))}</time>
          </dd>
        </dl>

        <div id="verification-round-counts" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '1.25rem' }}>
          {(
            [
              ['in-scope', SCOPE_SNAPSHOT_LABEL, counts.in_scope],
              ['not-yet-verified', RESULT_LABELS.NOT_YET_VERIFIED, counts.not_yet_verified],
            ] as const
          ).map(([key, label, count]) => (
            <div key={key} data-testid={`verification-round-count-${key}`} style={{ padding: '0.75rem 1rem', backgroundColor: '#f9fafb', borderRadius: '6px', border: '1px solid #e5e7eb', fontSize: '0.875rem' }}>
              {label} <strong style={{ fontSize: '1.125rem' }}>{count}</strong>
            </div>
          ))}
        </div>

        <h2 style={sectionHeadingStyle}>ประวัติของรอบ</h2>
        <ol data-testid="verification-round-history" style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.875rem', color: '#374151' }}>
          {history.map((event) => (
            <li key={event.id} style={{ marginBottom: '0.25rem' }}>
              {ROUND_EVENT_LABELS[event.kind]} โดย {event.recorded_by_username ?? event.recorded_by} เมื่อ{' '}
              <time dateTime={event.recorded_at}>{THAI_DATE_TIME.format(new Date(event.recorded_at))}</time>
              {event.reason && <> เหตุผล: {event.reason}</>}
            </li>
          ))}
        </ol>

        <h2 style={sectionHeadingStyle}>{SCOPE_SNAPSHOT_LABEL}</h2>
        <form
          id="scope-entry-search-form"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            show(draft, 0);
          }}
          style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}
        >
          <label htmlFor="scope-entry-search" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            ค้นหาหมายเลขครุภัณฑ์ Serial Number หรือชื่อ
          </label>
          <input
            id="scope-entry-search"
            type="search"
            placeholder="หมายเลขครุภัณฑ์ / Serial Number / ชื่อ"
            value={draft}
            // The server takes a search of at most 4096 bytes, which holds 1365 Thai characters.
            maxLength={1000}
            onChange={(e) => setDraft(e.target.value)}
            style={{ flex: '1 1 12rem', minWidth: 0, padding: '0.5rem 0.75rem', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '0.875rem' }}
          />
          <button type="submit" id="scope-entry-search-submit" style={{ padding: '0.5rem 1rem', backgroundColor: '#2563eb', color: '#ffffff', border: 'none', borderRadius: '4px', fontSize: '0.875rem', cursor: 'pointer' }}>
            ค้นหา
          </button>
        </form>

        {entries.isError && !isSignedOut && (
          <div role="alert" id="scope-entry-list-error" style={{ padding: '0.75rem 1rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            เกิดข้อผิดพลาดในการโหลด{SCOPE_SNAPSHOT_LABEL}{' '}
            <button type="button" id="scope-entry-list-retry" onClick={() => entries.refetch()}>
              ลองใหม่
            </button>
          </div>
        )}
        {entries.isPending && !entries.isError && (
          <div role="status" aria-busy="true" style={{ padding: '1rem', textAlign: 'center', color: '#6b7280', fontSize: '0.875rem' }}>
            กำลังโหลด{SCOPE_SNAPSHOT_LABEL}...
          </div>
        )}
        {page && (
          <section aria-label={SCOPE_SNAPSHOT_LABEL} id="scope-entry-list-region">
            <div id="scope-entry-list-count" style={{ fontSize: '0.875rem', color: '#6b7280' }}>
              {page.total_count > 0 ? `พบ ${page.total_count} รายการ (แสดง ${page.offset + 1} - ${Math.min(page.offset + page.items.length, page.total_count)})` : 'ไม่พบรายการ'}
            </div>
            <ul data-testid="scope-entry-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {page.items.map((entry) => (
                <ScopeEntryItem key={entry.id} entry={entry} />
              ))}
            </ul>
            {page.total_count > PAGE_SIZE && (
              <div id="scope-entry-pagination" style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '0.75rem', marginTop: '1rem', flexWrap: 'wrap' }}>
                <button type="button" id="scope-entry-prev" disabled={offset === 0} onClick={() => show(search, Math.max(0, offset - PAGE_SIZE))} style={pageButtonStyle(offset === 0)}>
                  ← ก่อนหน้า
                </button>
                <span id="scope-entry-page" style={{ fontSize: '0.875rem', color: '#4b5563' }}>
                  หน้า {Math.floor(page.offset / PAGE_SIZE) + 1} จาก {Math.ceil(page.total_count / PAGE_SIZE)}
                </span>
                <button type="button" id="scope-entry-next" disabled={!page.has_more} onClick={() => show(search, offset + PAGE_SIZE)} style={pageButtonStyle(!page.has_more)}>
                  ถัดไป →
                </button>
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
};

/** A Verification Round's page (F006-T1): its fields, history and Scope Snapshot, each Asset Not Yet Verified. */
export const VerificationRoundDetail: React.FC = () => {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <VerificationRoundDetailContent />
    </QueryClientProvider>
  );
};
