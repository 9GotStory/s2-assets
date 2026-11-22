import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { CompatibleStockMaterialAddForm, CompatibleStockMaterialEndForm } from '../components/CompatibleStockMaterialForms';
import { useCsrfToken } from '../components/materialQueries';
import { ACTIVE_LABEL, BASE_UNIT_LABEL, INACTIVE_LABEL, STOCK_MATERIAL_LABEL, UNIT_LABEL, WHOLE_NUMBER_UNIT_LABEL, wholeNumberLine, type StockMaterialUnit } from '../components/materialFacts';
import {
  ADD_COMPATIBLE_STOCK_MATERIAL_LABEL,
  COMPATIBLE_STOCK_MATERIAL_LABEL,
  CURRENT_COMPATIBLE_STOCK_MATERIAL_LABEL,
  END_COMPATIBLE_STOCK_MATERIAL_LABEL,
  ENDED_COMPATIBLE_STOCK_MATERIAL_LABEL,
  NO_COMPATIBLE_STOCK_MATERIAL_LABEL,
  isActiveWithoutCompatibleStockMaterial,
  noCompatibleBadgeStyle,
  REQUEST_UNIT_LABEL,
  REQUESTABLE_HISTORY_KIND_LABELS,
  REQUESTABLE_MATERIAL_LABEL,
  type RequestableMaterialDetail as RequestableDetail,
  type RequestableMaterialHistoryEntry,
  type RequestableMaterialRecordedChange,
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
const RECORDED_FIELD_LABELS: Record<RequestableMaterialRecordedChange['field'], string> = {
  name: 'ชื่อ',
  request_unit: REQUEST_UNIT_LABEL,
  whole_number_only: WHOLE_NUMBER_UNIT_LABEL,
  description: 'รายละเอียด',
  compatible_stock_material: COMPATIBLE_STOCK_MATERIAL_LABEL,
};

// A recorded value as the history shows it: the Request Unit by its name then, the whole-number setting as ใช่ or
// ไม่ใช่, text as it was; F009-T2: the Stock Material an add or an end names, by its name then.
const recordedValue = (change: RequestableMaterialRecordedChange): string => {
  if (change.field === 'compatible_stock_material') {
    return (change.after ?? change.before)!.name;
  }
  if (change.field === 'request_unit') {
    return change.after.name;
  }
  if (change.field === 'whole_number_only') {
    return wholeNumberLine(change.after);
  }
  return change.after;
};

const HistoryEntry: React.FC<{ entry: RequestableMaterialHistoryEntry }> = ({ entry }) => (
  <li data-testid={`requestable-material-history-${entry.version}`} style={{ borderLeft: '3px solid #d1d5db', padding: '0.25rem 0 0.75rem 0.75rem', marginBottom: '0.5rem' }}>
    <div style={{ fontWeight: 600, color: '#111827' }}>{REQUESTABLE_HISTORY_KIND_LABELS[entry.kind]}</div>
    <div style={{ fontSize: '0.8125rem', color: '#6b7280', marginBottom: '0.25rem' }}>
      บันทึกเมื่อ <time dateTime={entry.recorded_at}>{THAI_DATE_TIME.format(new Date(entry.recorded_at))}</time> โดย {entry.recorded_by_username}
    </div>
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.25rem 1rem', margin: 0, fontSize: '0.875rem' }}>
      {entry.changes.map((change) => (
        <React.Fragment key={change.field}>
          <dt style={{ color: '#4b5563' }}>{RECORDED_FIELD_LABELS[change.field]}</dt>
          <dd style={{ margin: 0, color: '#111827', whiteSpace: 'pre-line' }}>{recordedValue(change)}</dd>
        </React.Fragment>
      ))}
    </dl>
  </li>
);

// A Stock Material's Units as its row lists them: the Base Unit marked, an Inactive Alternate Unit marked.
const unitsLine = (units: StockMaterialUnit[]): string =>
  units.map((unit) => `${unit.name}${unit.is_base ? ` (${BASE_UNIT_LABEL})` : ''}${unit.is_active ? '' : ` (${INACTIVE_LABEL})`}`).join(', ');

const headStyle: React.CSSProperties = { textAlign: 'left', padding: '0.5rem 0.75rem', fontSize: '0.8125rem', color: '#4b5563', borderBottom: '1px solid #e5e7eb' };
const cellStyle: React.CSSProperties = { padding: '0.5rem 0.75rem', fontSize: '0.875rem', color: '#111827', verticalAlign: 'top' };
const actionStyle: React.CSSProperties = { padding: '0.375rem 0.75rem', borderRadius: '4px', border: '1px solid #d1d5db', backgroundColor: '#ffffff', cursor: 'pointer', fontWeight: 500 };

const RequestableMaterialDetailContent: React.FC<{ id: string }> = ({ id }) => {
  const navigate = useNavigate();
  // The Compatible Stock Material action opened: the add, or the end of one Stock Material.
  const [compatibleAction, setCompatibleAction] = useState<{ kind: 'add' } | { kind: 'end'; stockMaterialId: string } | null>(null);

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
  const refresh = async () => (await requestable.refetch()).isSuccess;
  const session = useCsrfToken(detail?.can_manage === true);
  // Each write action waits for the token: a request sent without it is refused as if the grant were gone (#135). A
  // token read before the grant went stays in hand, so `can_manage` decides too (P9).
  const csrfToken = session.data ?? null;
  const mayManage = detail?.can_manage === true && csrfToken !== null;
  const ending = compatibleAction?.kind === 'end' ? detail?.compatible_stock_materials.find((entry) => entry.stock_material_id === compatibleAction.stockMaterialId) : undefined;
  // What a form passes back to the page: a save reads the page again and closes it, and a lost grant or session reads
  // it again, which hides the actions or signs out.
  const formHandlers = {
    onRefresh: refresh,
    onSaved: async () => {
      await requestable.refetch();
      setCompatibleAction(null);
    },
    onCancel: () => setCompatibleAction(null),
    onPermissionRevoked: () => void requestable.refetch(),
  };

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
            {/* The badge sits beside the heading, which names the Requestable Material alone. */}
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', margin: '1rem 0 1rem 0' }}>
              <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: 0 }}>{detail.name}</h1>
              {isActiveWithoutCompatibleStockMaterial(detail) && (
                <span data-testid="requestable-material-no-compatible-badge" style={noCompatibleBadgeStyle}>
                  {NO_COMPATIBLE_STOCK_MATERIAL_LABEL}
                </span>
              )}
            </div>
            <dl id="requestable-material-fields" style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.5rem 1.5rem', margin: 0, fontSize: '0.9375rem' }}>
              <dt style={termStyle}>สถานะ</dt>
              <dd data-testid="requestable-material-status" style={{ margin: 0 }}>{detail.is_active ? ACTIVE_LABEL : INACTIVE_LABEL}</dd>
              <dt style={termStyle}>{REQUEST_UNIT_LABEL}</dt>
              <dd data-testid="requestable-material-request-unit" style={{ margin: 0 }}>
                {detail.request_unit.name}
              </dd>
              <dt style={termStyle}>{WHOLE_NUMBER_UNIT_LABEL}</dt>
              <dd data-testid="requestable-material-whole-number-only" style={{ margin: 0 }}>{wholeNumberLine(detail.whole_number_only)}</dd>
              <dt style={termStyle}>รายละเอียด</dt>
              <dd data-testid="requestable-material-description" style={{ margin: 0, whiteSpace: 'pre-line' }}>{detail.description ?? '-'}</dd>
              <dt style={termStyle}>สร้างเมื่อ</dt>
              <dd style={{ margin: 0 }}>
                <time dateTime={detail.recorded_at}>{THAI_DATE_TIME.format(new Date(detail.recorded_at))}</time> โดย {detail.created_by_username}
              </dd>
            </dl>

            <h2 style={sectionHeadingStyle}>{COMPATIBLE_STOCK_MATERIAL_LABEL}</h2>
            {detail.compatible_stock_materials.length === 0 ? (
              <p id="compatible-stock-material-empty" style={{ color: '#6b7280', fontSize: '0.875rem', margin: '0 0 0.75rem 0' }}>
                {NO_COMPATIBLE_STOCK_MATERIAL_LABEL}
              </p>
            ) : (
              <table id="compatible-stock-material-table" style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '0.75rem' }}>
                <thead>
                  <tr>
                    <th style={headStyle}>{STOCK_MATERIAL_LABEL}</th>
                    <th style={headStyle}>สถานะ{STOCK_MATERIAL_LABEL}</th>
                    <th style={headStyle}>{UNIT_LABEL}</th>
                    <th style={headStyle}>สถานะ</th>
                    {mayManage && <th style={headStyle} aria-label="การดำเนินการ" />}
                  </tr>
                </thead>
                <tbody>
                  {detail.compatible_stock_materials.map((compatible) => (
                    <tr key={compatible.stock_material_id} data-testid={`compatible-stock-material-row-${compatible.stock_material_id}`} style={{ borderBottom: '1px solid #e5e7eb' }}>
                      <td style={cellStyle}>
                        <Link to={`/stock-materials/${compatible.stock_material_id}`} style={{ color: '#2563eb', textDecoration: 'underline' }}>
                          {compatible.name}
                        </Link>
                      </td>
                      <td style={cellStyle}>{compatible.is_active ? ACTIVE_LABEL : INACTIVE_LABEL}</td>
                      <td style={cellStyle}>{unitsLine(compatible.units)}</td>
                      <td style={cellStyle}>{compatible.is_current ? CURRENT_COMPATIBLE_STOCK_MATERIAL_LABEL : ENDED_COMPATIBLE_STOCK_MATERIAL_LABEL}</td>
                      {mayManage && (
                        <td style={cellStyle}>
                          {compatible.is_current && compatibleAction === null && (
                            <button
                              type="button"
                              data-testid={`compatible-stock-material-end-${compatible.stock_material_id}`}
                              onClick={() => setCompatibleAction({ kind: 'end', stockMaterialId: compatible.stock_material_id })}
                              style={actionStyle}
                            >
                              {END_COMPATIBLE_STOCK_MATERIAL_LABEL}
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {mayManage && compatibleAction === null && (
              <button type="button" id="compatible-stock-material-add-action" onClick={() => setCompatibleAction({ kind: 'add' })} style={actionStyle}>
                {ADD_COMPATIBLE_STOCK_MATERIAL_LABEL}
              </button>
            )}
            {/* A new read starts a form again from what it shows, so a save never carries a version read before it. */}
            {mayManage && compatibleAction?.kind === 'add' && (
              <div style={{ marginTop: '1rem' }}>
                <CompatibleStockMaterialAddForm key={detail.version} requestable={detail} csrfToken={csrfToken} {...formHandlers} />
              </div>
            )}
            {mayManage && ending && (
              <div style={{ marginTop: '1rem' }}>
                <CompatibleStockMaterialEndForm key={detail.version} requestable={detail} compatible={ending} csrfToken={csrfToken} {...formHandlers} />
              </div>
            )}

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

/**
 * A Requestable Material's page (F009-T1): every field and its creation in the history (#202 Q17, Q19). F009-T2: its
 * Compatible Stock Materials, added and ended from here, and the "ยังไม่มีวัสดุที่ใช้จ่าย" badge (Q9); T7 and T8 add
 * the rest.
 */
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
