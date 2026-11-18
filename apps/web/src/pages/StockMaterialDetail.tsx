import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  BASE_UNIT_LABEL,
  CONVERSION_FACTOR_LABEL,
  HISTORY_KIND_LABELS,
  MODEL_LABEL,
  RECORDED_FIELD_LABELS,
  SPECIFICATION_LABEL,
  STOCK_MATERIAL_LABEL,
  UNIT_LABEL,
  WHOLE_NUMBER_UNIT_LABEL,
  unitLine,
  type RecordedUnit,
  type StockMaterialDetail as MaterialDetail,
  type StockMaterialHistoryEntry,
} from '../components/materialFacts';

const THAI_DATE_TIME = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

const LOAD_ERRORS: Record<number, string> = {
  403: 'คุณไม่มีสิทธิ์เข้าถึงข้อมูลวัสดุ (403 Forbidden)',
  404: 'ไม่พบวัสดุที่ระบุ (404 Not Found)',
  400: 'ไม่พบวัสดุที่ระบุ',
};

const sectionHeadingStyle: React.CSSProperties = { fontSize: '1.125rem', fontWeight: 600, color: '#374151', margin: '1.5rem 0 0.75rem 0' };
const cellStyle: React.CSSProperties = { padding: '0.5rem 0.75rem', color: '#111827', verticalAlign: 'top' };
const headStyle: React.CSSProperties = { padding: '0.5rem 0.75rem', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' };

// A recorded value as the history shows it: the Units as lines, text as it was, none as "-".
const recordedValue = (field: string, value: unknown): React.ReactNode => {
  if (value === null || value === undefined) {
    return '-';
  }
  if (field === 'units') {
    const units = value as RecordedUnit[];
    const baseName = units.find((unit) => unit.is_base)?.name ?? '';
    return units.map((unit) => <div key={unit.unit_id}>{unitLine(unit, baseName)}</div>);
  }
  return String(value);
};

const HistoryEntry: React.FC<{ entry: StockMaterialHistoryEntry }> = ({ entry }) => (
  <li data-testid={`stock-material-history-${entry.version}`} style={{ borderLeft: '3px solid #d1d5db', padding: '0.25rem 0 0.75rem 0.75rem', marginBottom: '0.5rem' }}>
    <div style={{ fontWeight: 600, color: '#111827' }}>{HISTORY_KIND_LABELS[entry.kind] ?? entry.kind}</div>
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

const StockMaterialDetailContent: React.FC<{ id: string }> = ({ id }) => {
  const navigate = useNavigate();

  const material = useQuery<MaterialDetail, Error & { status?: number }>({
    queryKey: ['stock-material', id],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/stock-materials/${encodeURIComponent(id)}`, { credentials: 'include', signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
  });

  const isSignedOut = material.error?.status === 401;
  useEffect(() => {
    if (isSignedOut) {
      navigate('/login', { replace: true });
    }
  }, [isSignedOut, navigate]);

  // A failed read hides what an earlier one showed: a lost grant fails closed.
  const detail = material.isError ? undefined : material.data;
  const baseUnit = detail?.units.find((unit) => unit.is_base);

  return (
    <main style={{ minHeight: '100vh', backgroundColor: '#f3f4f6', padding: '1rem', fontFamily: 'system-ui, -apple-system, sans-serif', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: '900px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1)', padding: '1.25rem', boxSizing: 'border-box' }}>
        <Link to="/stock-materials" id="back-stock-material-list-link" style={{ color: '#4b5563', textDecoration: 'none', fontSize: '0.875rem', fontWeight: 500 }}>
          ← กลับสู่รายการ{STOCK_MATERIAL_LABEL}
        </Link>

        {material.isError && !isSignedOut && (
          <div role="alert" id="stock-material-detail-error" style={{ padding: '0.75rem 1rem', margin: '1rem 0', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            {LOAD_ERRORS[material.error.status ?? 0] ?? 'เกิดข้อผิดพลาดในการโหลดข้อมูลวัสดุ'}
          </div>
        )}

        {material.isPending && (
          <div role="status" aria-busy="true" style={{ padding: '2rem', textAlign: 'center', color: '#6b7280', fontSize: '0.875rem' }}>
            กำลังโหลดข้อมูลวัสดุ...
          </div>
        )}

        {detail && (
          <>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: '1rem 0 1rem 0' }}>{detail.name}</h1>
            <dl id="stock-material-fields" style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.5rem 1.5rem', margin: 0, fontSize: '0.9375rem' }}>
              <dt style={{ fontWeight: 500, color: '#4b5563' }}>{MODEL_LABEL}</dt>
              <dd data-testid="stock-material-model" style={{ margin: 0 }}>{detail.model ?? '-'}</dd>
              <dt style={{ fontWeight: 500, color: '#4b5563' }}>{SPECIFICATION_LABEL}</dt>
              <dd data-testid="stock-material-specification" style={{ margin: 0, whiteSpace: 'pre-line' }}>{detail.specification ?? '-'}</dd>
              <dt style={{ fontWeight: 500, color: '#4b5563' }}>หมายเหตุ</dt>
              <dd data-testid="stock-material-note" style={{ margin: 0, whiteSpace: 'pre-line' }}>{detail.note ?? '-'}</dd>
              <dt style={{ fontWeight: 500, color: '#4b5563' }}>สร้างเมื่อ</dt>
              <dd style={{ margin: 0 }}>
                <time dateTime={detail.recorded_at}>{THAI_DATE_TIME.format(new Date(detail.recorded_at))}</time> โดย {detail.created_by_username ?? detail.created_by}
              </dd>
            </dl>

            <h2 style={sectionHeadingStyle}>{UNIT_LABEL}</h2>
            <div style={{ overflowX: 'auto' }}>
              <table id="stock-material-units" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.875rem' }}>
                <thead>
                  <tr style={{ backgroundColor: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                    <th style={headStyle}>{UNIT_LABEL}</th>
                    <th style={headStyle}>{CONVERSION_FACTOR_LABEL}</th>
                    <th style={headStyle}>{WHOLE_NUMBER_UNIT_LABEL}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.units.map((unit) => (
                    <tr key={unit.unit_id} data-testid={`stock-material-unit-${unit.unit_id}`} style={{ borderBottom: '1px solid #e5e7eb' }}>
                      <td style={cellStyle}>
                        {unit.name}
                        {unit.is_base && <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: '#1d4ed8' }}>({BASE_UNIT_LABEL})</span>}
                      </td>
                      <td style={cellStyle}>{unit.is_base ? '-' : `1 ${unit.name} = ${unit.conversion_factor} ${baseUnit?.name ?? ''}`}</td>
                      <td style={cellStyle}>{unit.whole_number_only ? 'ใช่' : 'ไม่ใช่ (มีเศษได้)'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h2 style={sectionHeadingStyle}>ประวัติ</h2>
            <ol id="stock-material-history" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
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

/** A Stock Material's page (F008-T1): every field, its Units and its history (#175 Q15, Q18). */
export const StockMaterialDetail: React.FC = () => {
  const { id = '' } = useParams<{ id: string }>();
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <StockMaterialDetailContent key={id} id={id} />
    </QueryClientProvider>
  );
};
