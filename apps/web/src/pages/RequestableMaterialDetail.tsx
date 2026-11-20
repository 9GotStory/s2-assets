import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ACTIVE_LABEL, INACTIVE_LABEL, WHOLE_NUMBER_UNIT_LABEL, type NamedListEntry } from '../components/materialFacts';
import {
  REQUEST_UNIT_LABEL,
  REQUESTABLE_HISTORY_KIND_LABELS,
  REQUESTABLE_MATERIAL_LABEL,
  type RequestableMaterialDetail as RequestableDetail,
  type RequestableMaterialHistoryEntry,
} from '../components/requestableMaterialFacts';

const THAI_DATE_TIME = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

const LOAD_ERRORS: Record<number, string> = {
  403: `คุณไม่มีสิทธิ์เข้าถึงข้อมูล${REQUESTABLE_MATERIAL_LABEL} (403 Forbidden)`,
  404: `ไม่พบ${REQUESTABLE_MATERIAL_LABEL}ที่ระบุ (404 Not Found)`,
  400: `ไม่พบ${REQUESTABLE_MATERIAL_LABEL}ที่ระบุ`,
};

const sectionHeadingStyle: React.CSSProperties = { fontSize: '1.125rem', fontWeight: 600, color: '#374151', margin: '1.5rem 0 0.75rem 0' };
const termStyle: React.CSSProperties = { fontWeight: 500, color: '#4b5563' };

// What each recorded field is called in a history entry.
const RECORDED_FIELD_LABELS: Record<string, string> = {
  name: 'ชื่อ',
  request_unit: REQUEST_UNIT_LABEL,
  whole_number_only: WHOLE_NUMBER_UNIT_LABEL,
  description: 'รายละเอียด',
};

// Whether the quantities must be whole, as the page says it.
const wholeNumberLine = (wholeNumberOnly: boolean) => (wholeNumberOnly ? 'ใช่' : 'ไม่ใช่ (มีเศษได้)');

// A recorded value as the history shows it: the Request Unit by its name then, the whole-number setting as ใช่ or
// ไม่ใช่, text as it was.
const recordedValue = (field: string, value: unknown): React.ReactNode => {
  if (value === null || value === undefined) {
    return '-';
  }
  if (field === 'request_unit') {
    return (value as NamedListEntry).name;
  }
  if (typeof value === 'boolean') {
    return wholeNumberLine(value);
  }
  return String(value);
};

const HistoryEntry: React.FC<{ entry: RequestableMaterialHistoryEntry }> = ({ entry }) => (
  <li data-testid={`requestable-material-history-${entry.version}`} style={{ borderLeft: '3px solid #d1d5db', padding: '0.25rem 0 0.75rem 0.75rem', marginBottom: '0.5rem' }}>
    <div style={{ fontWeight: 600, color: '#111827' }}>{REQUESTABLE_HISTORY_KIND_LABELS[entry.kind] ?? entry.kind}</div>
    <div style={{ fontSize: '0.8125rem', color: '#6b7280', marginBottom: '0.25rem' }}>
      บันทึกเมื่อ <time dateTime={entry.recorded_at}>{THAI_DATE_TIME.format(new Date(entry.recorded_at))}</time> โดย {entry.recorded_by_username ?? entry.recorded_by}
    </div>
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.25rem 1rem', margin: 0, fontSize: '0.875rem' }}>
      {entry.changes.map((change) => (
        <React.Fragment key={change.field}>
          <dt style={{ color: '#4b5563' }}>{RECORDED_FIELD_LABELS[change.field] ?? change.field}</dt>
          <dd style={{ margin: 0, color: '#111827', whiteSpace: 'pre-line' }}>
            {change.before !== null && change.before !== undefined && (
              <>
                <s>{recordedValue(change.field, change.before)}</s> →{' '}
              </>
            )}
            {recordedValue(change.field, change.after)}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  </li>
);

const RequestableMaterialDetailContent: React.FC<{ id: string }> = ({ id }) => {
  const navigate = useNavigate();

  const requestable = useQuery<RequestableDetail, Error & { status?: number }>({
    queryKey: ['requestable-material', id],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/requestable-materials/${encodeURIComponent(id)}`, { credentials: 'include', signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
  });

  const isSignedOut = requestable.error?.status === 401;
  useEffect(() => {
    if (isSignedOut) {
      navigate('/login', { replace: true });
    }
  }, [isSignedOut, navigate]);

  // A failed read hides what an earlier one showed: a lost grant fails closed.
  const detail = requestable.isError ? undefined : requestable.data;

  return (
    <main style={{ minHeight: '100vh', backgroundColor: '#f3f4f6', padding: '1rem', fontFamily: 'system-ui, -apple-system, sans-serif', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: '900px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1)', padding: '1.25rem', boxSizing: 'border-box' }}>
        <Link to="/requestable-materials" id="back-requestable-material-list-link" style={{ color: '#4b5563', textDecoration: 'none', fontSize: '0.875rem', fontWeight: 500 }}>
          ← กลับสู่รายการ{REQUESTABLE_MATERIAL_LABEL}
        </Link>

        {requestable.isError && !isSignedOut && (
          <div role="alert" id="requestable-material-detail-error" style={{ padding: '0.75rem 1rem', margin: '1rem 0', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            {LOAD_ERRORS[requestable.error.status ?? 0] ?? `เกิดข้อผิดพลาดในการโหลดข้อมูล${REQUESTABLE_MATERIAL_LABEL}`}
          </div>
        )}

        {requestable.isPending && (
          <div role="status" aria-busy="true" style={{ padding: '2rem', textAlign: 'center', color: '#6b7280', fontSize: '0.875rem' }}>
            กำลังโหลดข้อมูล{REQUESTABLE_MATERIAL_LABEL}...
          </div>
        )}

        {detail && (
          <>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: '1rem 0 1rem 0' }}>{detail.name}</h1>
            <dl id="requestable-material-fields" style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.5rem 1.5rem', margin: 0, fontSize: '0.9375rem' }}>
              <dt style={termStyle}>สถานะ</dt>
              <dd data-testid="requestable-material-status" style={{ margin: 0 }}>{detail.is_active ? ACTIVE_LABEL : INACTIVE_LABEL}</dd>
              <dt style={termStyle}>{REQUEST_UNIT_LABEL}</dt>
              <dd data-testid="requestable-material-request-unit" style={{ margin: 0 }}>
                {detail.request_unit.name}
                {/* The Unit list's entry went Inactive after it was chosen; the Requestable Material keeps working (#202 Q15). */}
                {!detail.request_unit.unit_is_active && ` (${INACTIVE_LABEL})`}
              </dd>
              <dt style={termStyle}>{WHOLE_NUMBER_UNIT_LABEL}</dt>
              <dd data-testid="requestable-material-whole-number-only" style={{ margin: 0 }}>{wholeNumberLine(detail.whole_number_only)}</dd>
              <dt style={termStyle}>รายละเอียด</dt>
              <dd data-testid="requestable-material-description" style={{ margin: 0, whiteSpace: 'pre-line' }}>{detail.description ?? '-'}</dd>
              <dt style={termStyle}>สร้างเมื่อ</dt>
              <dd style={{ margin: 0 }}>
                <time dateTime={detail.recorded_at}>{THAI_DATE_TIME.format(new Date(detail.recorded_at))}</time> โดย {detail.created_by_username ?? detail.created_by}
              </dd>
            </dl>

            <h2 style={sectionHeadingStyle}>ประวัติ</h2>
            <ol id="requestable-material-history" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {detail.history.map((entry) => (
                <HistoryEntry key={entry.version} entry={entry} />
              ))}
            </ol>
          </>
        )}
      </div>
    </main>
  );
};

/** A Requestable Material's page (F009-T1): every field and its history (#202 Q17, Q19); T2, T7 and T8 add its actions. */
export const RequestableMaterialDetail: React.FC = () => {
  const { id = '' } = useParams<{ id: string }>();
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <RequestableMaterialDetailContent key={id} id={id} />
    </QueryClientProvider>
  );
};
