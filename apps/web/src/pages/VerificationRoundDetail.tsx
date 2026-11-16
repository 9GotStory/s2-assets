import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { REFERENCE_DIMENSIONS, entryLabel } from '../components/ReferenceContextFields';
import { thaiDate, valueText } from '../components/assignmentFacts';
import { RecordingContextLine, RevisionDiscrepancies } from '../components/VerificationPanel';
import { VerificationRevisionList } from '../components/VerificationRevisionList';
import {
  DISCREPANCIES,
  DISCREPANCY_LABEL,
  DISCREPANCY_LABELS,
  FISCAL_YEAR_LABEL,
  RESULT_LABELS,
  ROUND_EVENT_LABELS,
  ROUND_STATE_LABELS,
  SCOPE_SNAPSHOT_LABEL,
  START_DATE_LABEL,
  VERIFICATION_DATE_LABEL,
  VERIFICATION_ROUND_LABEL,
  WHOLE_REGISTER_LABEL,
  recordedByText,
  recordedContextText,
  resultText,
  type Discrepancy,
  type ScopeEntry,
  type ScopeEntryPage,
  type VerificationResult,
  type VerificationRound,
} from '../components/verificationFacts';

const PAGE_SIZE = 25;

// The results the list filters by (#125 AV-19); none shows every entry.
const RESULT_FILTERS: readonly VerificationResult[] = ['FOUND', 'NOT_FOUND', 'NOT_YET_VERIFIED'];
const isResultFilter = (value: string | null): value is VerificationResult => RESULT_FILTERS.includes(value as VerificationResult);
const isDiscrepancyFilter = (value: string | null): value is Discrepancy => DISCREPANCIES.includes(value as Discrepancy);

// What the entry list shows: a search, a result, a Discrepancy and a snapshot Location, each null for any (#125 AV-19, P5).
interface ListFilters {
  search: string;
  result: VerificationResult | null;
  discrepancy: Discrepancy | null;
  locationId: string | null;
}

// The list's URL query for its filters and a page.
const listQuery = ({ search, result, discrepancy, locationId }: ListFilters, offset: number): string => {
  const params = new URLSearchParams();
  if (search.trim()) params.set('search', search.trim());
  if (result) params.set('result', result);
  if (discrepancy) params.set('discrepancy', discrepancy);
  if (locationId) params.set('location_id', locationId);
  if (offset > 0) params.set('offset', String(offset));
  return params.toString();
};

const filterLinkStyle = (isCurrent: boolean): React.CSSProperties => ({
  padding: '0.375rem 0.75rem',
  borderRadius: '9999px',
  border: '1px solid #d1d5db',
  textDecoration: 'none',
  backgroundColor: isCurrent ? '#2563eb' : '#ffffff',
  color: isCurrent ? '#ffffff' : '#374151',
});

// One filter of the list as links, "ทั้งหมด" first. Links, not buttons: a filter is a URL that a back step or a
// shared link keeps.
const FilterLinks = <T extends string>({
  label,
  idPrefix,
  values,
  current,
  allLabel,
  valueLabel,
  queryFor,
}: {
  label: string;
  idPrefix: string;
  values: readonly T[];
  current: T | null;
  allLabel: string;
  valueLabel: (value: T) => string;
  queryFor: (value: T | null) => string;
}) => (
  <nav aria-label={label} id={`${idPrefix}s`} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem', fontSize: '0.875rem' }}>
    {([null, ...values] as const).map((value) => (
      <Link
        key={value ?? 'ALL'}
        to={`?${queryFor(value)}`}
        id={`${idPrefix}-${value ?? 'ALL'}`}
        aria-current={value === current ? 'page' : undefined}
        style={filterLinkStyle(value === current)}
      >
        {value ? valueLabel(value) : allLabel}
      </Link>
    ))}
  </nav>
);

const RESULT_COLORS: Record<VerificationResult, string> = { FOUND: '#166534', NOT_FOUND: '#991b1b', NOT_YET_VERIFIED: '#92400e' };

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

// One Asset of the Scope Snapshot as the register showed it when the Round opened (#125 Q4), with its current
// result, its Observed Location and Discrepancies (Q7), the Loan or Repair context that result kept (Q14), and its
// revisions (F006-T4).
const ScopeEntryItem: React.FC<{ roundId: string; entry: ScopeEntry; dataUpdatedAt: number }> = ({ roundId, entry, dataUpdatedAt }) => {
  const { snapshot, current } = entry;
  return (
    <li data-testid={`scope-entry-${entry.asset_id}`} style={{ padding: '0.75rem 0', borderBottom: '1px solid #e5e7eb', fontSize: '0.875rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
        <Link to={`/assets/${entry.asset_id}`} style={{ color: '#2563eb', textDecoration: 'underline', fontWeight: 600, overflowWrap: 'anywhere' }}>
          {snapshot.name ?? snapshot.asset_number ?? entry.asset_id}
        </Link>
        <span data-testid={`scope-entry-result-${entry.asset_id}`} style={{ color: RESULT_COLORS[entry.result], fontWeight: 600, whiteSpace: 'nowrap' }}>
          {resultText(entry.result, current?.condition)}
        </span>
      </div>
      {current && (
        <div data-testid={`scope-entry-verification-${entry.asset_id}`} style={{ color: '#4b5563', marginTop: '0.25rem', overflowWrap: 'anywhere' }}>
          {VERIFICATION_DATE_LABEL} <time dateTime={current.verification_date}>{thaiDate(current.verification_date)}</time> บันทึกโดย {recordedByText(current)}
          <RevisionDiscrepancies revision={current} testId={`scope-entry-discrepancies-${entry.asset_id}`} />
          {recordedContextText(current) && (
            <div style={{ color: '#92400e' }}>
              ขณะตรวจ: <RecordingContextLine context={current} />
            </div>
          )}
        </div>
      )}
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
      {entry.revision_count > 0 && <VerificationRevisionList roundId={roundId} assetId={entry.asset_id} revisionCount={entry.revision_count} dataUpdatedAt={dataUpdatedAt} />}
    </li>
  );
};

const VerificationRoundDetailContent: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get('search') ?? '';
  const resultParam = searchParams.get('result');
  const discrepancyParam = searchParams.get('discrepancy');
  const filters: ListFilters = {
    search,
    result: isResultFilter(resultParam) ? resultParam : null,
    discrepancy: isDiscrepancyFilter(discrepancyParam) ? discrepancyParam : null,
    locationId: searchParams.get('location_id') || null,
  };
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
    queryKey: ['verification-round-entries', id, filters, offset],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams(listQuery(filters, offset));
      params.set('limit', String(PAGE_SIZE));
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

  const show = (next: Partial<ListFilters>, nextOffset: number) => setSearchParams(listQuery({ ...filters, ...next }, nextOffset));

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

  const {
    name,
    fiscal_year: fiscalYear,
    start_date: startDate,
    state,
    notes,
    filters: roundFilters,
    counts,
    opened_by: openedBy,
    opened_by_username: openedByUsername,
    recorded_at: recordedAt,
    history,
    snapshot_locations: snapshotLocations,
  } = round.data;
  const page = entries.isError ? undefined : entries.data;
  const filterText = (label: string, chosen: { id: string; name: string; is_active: boolean }[]) => (chosen.length > 0 ? `${label}: ${chosen.map(entryLabel).join(', ')}` : null);
  const scopeText = [filterText('หน่วยงาน', roundFilters.organization_units), filterText('สถานที่', roundFilters.locations)].filter(Boolean).join(' และ ') || WHOLE_REGISTER_LABEL;

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
              ['found', RESULT_LABELS.FOUND, counts.found],
              ['not-found', RESULT_LABELS.NOT_FOUND, counts.not_found],
              ['not-yet-verified', RESULT_LABELS.NOT_YET_VERIFIED, counts.not_yet_verified],
              ['with-discrepancy', `มี${DISCREPANCY_LABEL}`, counts.with_discrepancy],
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
            show({ search: draft }, 0);
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

        <FilterLinks
          label="กรองตามผลตรวจ"
          idPrefix="scope-entry-result-filter"
          values={RESULT_FILTERS}
          current={filters.result}
          allLabel="ทั้งหมด"
          valueLabel={(value) => RESULT_LABELS[value]}
          queryFor={(value) => listQuery({ ...filters, result: value }, 0)}
        />
        <FilterLinks
          label={`กรองตาม${DISCREPANCY_LABEL}`}
          idPrefix="scope-entry-discrepancy-filter"
          values={DISCREPANCIES}
          current={filters.discrepancy}
          allLabel={`${DISCREPANCY_LABEL}ทั้งหมด`}
          valueLabel={(value) => DISCREPANCY_LABELS[value]}
          queryFor={(value) => listQuery({ ...filters, discrepancy: value }, 0)}
        />
        {snapshotLocations.length > 0 && (
          <div style={{ marginBottom: '0.75rem', fontSize: '0.875rem' }}>
            {/* The Location the snapshot holds, to walk the office room by room (#125 P5). */}
            <label htmlFor="scope-entry-location-filter" style={{ marginRight: '0.5rem', color: '#4b5563' }}>
              สถานที่ตามรายการในรอบ:
            </label>
            <select
              id="scope-entry-location-filter"
              value={filters.locationId ?? ''}
              onChange={(e) => show({ locationId: e.target.value || null }, 0)}
              style={{ maxWidth: '100%', padding: '0.375rem 0.5rem', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '0.875rem' }}
            >
              <option value="">ทุกสถานที่</option>
              {snapshotLocations.map((location) => (
                <option key={location.id} value={location.id}>
                  {entryLabel(location)}
                </option>
              ))}
            </select>
          </div>
        )}

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
                <ScopeEntryItem key={entry.id} roundId={round.data.id} entry={entry} dataUpdatedAt={entries.dataUpdatedAt} />
              ))}
            </ul>
            {page.total_count > PAGE_SIZE && (
              <div id="scope-entry-pagination" style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '0.75rem', marginTop: '1rem', flexWrap: 'wrap' }}>
                <button type="button" id="scope-entry-prev" disabled={offset === 0} onClick={() => show({}, Math.max(0, offset - PAGE_SIZE))} style={pageButtonStyle(offset === 0)}>
                  ← ก่อนหน้า
                </button>
                <span id="scope-entry-page" style={{ fontSize: '0.875rem', color: '#4b5563' }}>
                  หน้า {Math.floor(page.offset / PAGE_SIZE) + 1} จาก {Math.ceil(page.total_count / PAGE_SIZE)}
                </span>
                <button type="button" id="scope-entry-next" disabled={!page.has_more} onClick={() => show({}, offset + PAGE_SIZE)} style={pageButtonStyle(!page.has_more)}>
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

/**
 * A Verification Round's page (F006-T1, F006-T2, F006-T3): its fields, counts, history and Scope Snapshot with each
 * Asset's current result and Discrepancies, filtered by result, Discrepancy and snapshot Location.
 */
export const VerificationRoundDetail: React.FC = () => {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <VerificationRoundDetailContent />
    </QueryClientProvider>
  );
};
