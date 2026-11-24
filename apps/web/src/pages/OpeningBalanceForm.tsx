import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { LoanSaveForm } from '../components/LoanSaveForm';
import { useCsrfToken } from '../components/materialQueries';
import { INACTIVE_LABEL, STOCK_MATERIAL_LABEL, UNIT_LABEL, type StockMaterialDetail, type StockMaterialList } from '../components/materialFacts';
import { fieldInputStyle, fieldLabelStyle } from '../components/ReferenceContextFields';
import {
  ADD_OPENING_BALANCE_LABEL,
  AS_OF_DATE_LABEL,
  EDIT_DRAFT_LABEL,
  OPENING_BALANCE_LABEL,
  OPENING_BALANCE_SOURCE_LABEL,
  SAVE_DRAFT_LABEL,
  type OpeningBalanceDetail,
  type OpeningBalanceList,
} from '../components/openingBalanceFacts';

// #231 Q25, P7: at most 50 lines; the source 500 characters, the note 2000 and a line's note 500.
const MAX_LINES = 50;
const CHOICES_PAGE_SIZE = 10;

// A line as the form holds it: its Stock Material with the Units it may be counted in, and what is typed.
interface DraftLine {
  stock_material_id: string;
  name: string;
  is_active: boolean;
  // The Stock Material's active Units (#231 Q11), and the chosen one even when no longer active.
  units: { unit_id: string; name: string }[];
  unit_id: string;
  quantity: string;
  note: string;
}

// A read that fails with its HTTP status.
const readJson = async <T,>(path: string, signal?: AbortSignal): Promise<T> => {
  const res = await fetch(path, { credentials: 'include', signal });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
};

// The Units a line of the Stock Material `id` may name: its active ones, and `kept` when the Draft already names it.
const unitsOf = async (id: string, kept: string | null): Promise<{ name: string; is_active: boolean; units: DraftLine['units'] }> => {
  const material = await readJson<StockMaterialDetail>(`/stock-materials/${encodeURIComponent(id)}`);
  return {
    name: material.name,
    is_active: material.is_active,
    units: material.units.filter((unit) => unit.is_active || unit.unit_id === kept).map(({ unit_id, name, is_active }) => ({ unit_id, name: is_active ? name : `${name} (${INACTIVE_LABEL})` })),
  };
};

const OpeningBalanceFormContent: React.FC<{ id: string | null }> = ({ id }) => {
  const navigate = useNavigate();
  const [asOfDate, setAsOfDate] = useState('');
  const [source, setSource] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [version, setVersion] = useState<number | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState<string | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // A new Draft asks the list whether the viewer may write; an existing one is read whole, its lines with their Units.
  const grant = useQuery<OpeningBalanceList, Error & { status?: number }>({
    queryKey: ['opening-balance-grant'],
    queryFn: ({ signal }) => readJson('/opening-balances?limit=1', signal),
    enabled: id === null,
  });
  const existing = useQuery<OpeningBalanceDetail, Error & { status?: number }>({
    queryKey: ['opening-balance', id],
    queryFn: ({ signal }) => readJson(`/opening-balances/${encodeURIComponent(id!)}`, signal),
    enabled: id !== null,
  });
  useEffect(() => {
    const detail = existing.data;
    if (!detail || version !== null) {
      return;
    }
    setVersion(detail.version);
    setAsOfDate(detail.as_of_date ?? '');
    setSource(detail.source ?? '');
    setNote(detail.note ?? '');
    void Promise.all(
      detail.lines.map(async (line) => ({
        stock_material_id: line.stock_material.id,
        ...(await unitsOf(line.stock_material.id, line.unit?.unit_id ?? null)),
        unit_id: line.unit?.unit_id ?? '',
        quantity: line.quantity ?? '',
        note: line.note ?? '',
      }))
    ).then(setLines, () => setAddError('ไม่สามารถโหลดหน่วยนับของวัสดุได้ กรุณาโหลดใหม่'));
  }, [existing.data, version]);

  const choices = useQuery<StockMaterialList, Error & { status?: number }>({
    queryKey: ['opening-balance-stock-material-choices', search, includeInactive],
    queryFn: ({ signal }) => {
      const query = new URLSearchParams({ limit: String(CHOICES_PAGE_SIZE), status: includeInactive ? 'all' : 'active' });
      if (search !== null && search.trim() !== '') {
        query.set('search', search.trim());
      }
      return readJson(`/stock-materials?${query}`, signal);
    },
    enabled: search !== null,
  });

  const loadError = id === null ? grant.error : existing.error;
  const isSignedOut = loadError?.status === 401;
  useEffect(() => {
    if (isSignedOut) {
      navigate('/login', { replace: true });
    }
  }, [isSignedOut, navigate]);

  const mayManage = id === null ? grant.data?.can_manage === true : existing.data?.can_manage === true && existing.data.state === 'DRAFT';
  const session = useCsrfToken(mayManage);
  const csrfToken = session.data ?? null;
  const ready = mayManage && csrfToken !== null && (id === null || version !== null);

  const addLine = async (materialId: string) => {
    setAddError(null);
    if (lines.some((line) => line.stock_material_id === materialId)) {
      setAddError(`${STOCK_MATERIAL_LABEL}นี้อยู่ในรายการแล้ว`);
      return;
    }
    try {
      const material = await unitsOf(materialId, null);
      setLines((current) => [...current, { stock_material_id: materialId, ...material, unit_id: material.units[0]?.unit_id ?? '', quantity: '', note: '' }]);
    } catch {
      setAddError('ไม่สามารถโหลดหน่วยนับของวัสดุได้ กรุณาลองใหม่');
    }
  };
  const changeLine = (index: number, change: Partial<DraftLine>) => setLines((current) => current.map((line, at) => (at === index ? { ...line, ...change } : line)));

  const heading = id === null ? ADD_OPENING_BALANCE_LABEL : EDIT_DRAFT_LABEL;
  return (
    <main style={{ minHeight: '100vh', backgroundColor: '#f3f4f6', padding: '1rem', fontFamily: 'system-ui, -apple-system, sans-serif', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: '1000px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1)', padding: '1.25rem', boxSizing: 'border-box' }}>
        <Link to={id === null ? '/opening-balances' : `/opening-balances/${id}`} id="back-opening-balance-link" style={{ color: '#4b5563', textDecoration: 'none', fontSize: '0.875rem', fontWeight: 500 }}>
          ← กลับสู่{OPENING_BALANCE_LABEL}
        </Link>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: '1rem 0 1.5rem 0' }}>{heading}</h1>

        {loadError && !isSignedOut && (
          <div role="alert" id="opening-balance-form-load-error" style={{ padding: '0.75rem 1rem', marginBottom: '1rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            {loadError.status === 403 ? `คุณไม่มีสิทธิ์เข้าถึง${OPENING_BALANCE_LABEL} (403 Forbidden)` : `เกิดข้อผิดพลาดในการโหลด${OPENING_BALANCE_LABEL}`}
          </div>
        )}
        {!loadError && (grant.isSuccess || existing.isSuccess) && !mayManage && (
          <div role="alert" id="opening-balance-form-not-allowed" style={{ padding: '0.75rem 1rem', marginBottom: '1rem', borderRadius: '6px', backgroundColor: '#fef3c7', color: '#92400e', fontSize: '0.875rem' }}>
            {id === null ? `คุณไม่มีสิทธิ์บันทึก${OPENING_BALANCE_LABEL}` : `แก้ไขได้เฉพาะร่างโดยผู้มีสิทธิ์บันทึก${OPENING_BALANCE_LABEL}`}
          </div>
        )}

        {ready && (
          <LoanSaveForm
            idPrefix="opening-balance-draft"
            heading={heading}
            saveUrl={id === null ? '/opening-balances' : `/opening-balances/${encodeURIComponent(id)}`}
            method={id === null ? 'POST' : 'PUT'}
            csrfToken={csrfToken}
            requestError={() => null}
            requestBody={() => ({
              ...(id === null ? {} : { expected_version: version }),
              as_of_date: asOfDate === '' ? null : asOfDate,
              // The API trims free text and saves a blank one as none.
              source,
              note,
              lines: lines.map((line) => ({
                stock_material_id: line.stock_material_id,
                unit_id: line.unit_id === '' ? null : line.unit_id,
                quantity: line.quantity.trim() === '' ? null : line.quantity.trim(),
                note: line.note,
              })),
            })}
            refusedList={() => null}
            forbiddenMessage={`คุณไม่มีสิทธิ์บันทึก${OPENING_BALANCE_LABEL}`}
            refusedMessage={`ไม่สามารถบันทึก${OPENING_BALANCE_LABEL}ได้`}
            staleMessage="มีผู้แก้ไขร่างนี้ไปแล้ว กรุณาโหลดใหม่"
            submitLabel={SAVE_DRAFT_LABEL}
            onRefresh={
              id === null
                ? undefined
                : async () => {
                    setVersion(null);
                    return (await existing.refetch()).isSuccess;
                  }
            }
            onSaved={async (body) => {
              navigate(`/opening-balances/${body.opening_balance_id}`);
            }}
            onCancel={() => navigate(id === null ? '/opening-balances' : `/opening-balances/${id}`)}
          >
            {(isLocked) => (
              <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0', minWidth: 0 }}>
                <p style={{ fontSize: '0.875rem', color: '#4b5563', margin: '0 0 0.75rem 0' }}>บันทึกร่างได้แม้ยังกรอกไม่ครบ ระบบจะตรวจทั้งหมดอีกครั้งเมื่อยืนยัน</p>
                <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
                  <div style={{ flex: '0 1 12rem' }}>
                    <label htmlFor="opening-balance-as-of-date" style={fieldLabelStyle}>
                      {AS_OF_DATE_LABEL}
                    </label>
                    <input id="opening-balance-as-of-date" type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} style={fieldInputStyle} />
                  </div>
                  <div style={{ flex: '1 1 20rem' }}>
                    <label htmlFor="opening-balance-source" style={fieldLabelStyle}>
                      {OPENING_BALANCE_SOURCE_LABEL}
                    </label>
                    <input
                      id="opening-balance-source"
                      value={source}
                      maxLength={500}
                      placeholder="เช่น สมุดคุมวัสดุ แฟ้มนับวัสดุ หรือการตรวจนับครั้งก่อน"
                      onChange={(e) => setSource(e.target.value)}
                      style={fieldInputStyle}
                    />
                  </div>
                </div>
                <div style={{ marginBottom: '1rem' }}>
                  <label htmlFor="opening-balance-note" style={fieldLabelStyle}>
                    หมายเหตุ (ไม่บังคับ)
                  </label>
                  <textarea id="opening-balance-note" value={note} maxLength={2000} rows={2} onChange={(e) => setNote(e.target.value)} style={fieldInputStyle} />
                </div>

                <h2 style={{ fontSize: '1rem', fontWeight: 600, color: '#111827', margin: '0 0 0.5rem 0' }}>รายการ ({lines.length}/{MAX_LINES})</h2>
                {lines.map((line, index) => (
                  <div key={line.stock_material_id} data-testid={`opening-balance-line-${index}`} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end', padding: '0.5rem 0', borderBottom: '1px solid #e5e7eb' }}>
                    <div style={{ flex: '1 1 14rem', fontSize: '0.875rem', color: '#111827', alignSelf: 'center' }}>
                      {line.name}
                      {!line.is_active && ` (${INACTIVE_LABEL})`}
                    </div>
                    <div style={{ flex: '0 1 8rem' }}>
                      <label htmlFor={`opening-balance-line-${index}-quantity`} style={fieldLabelStyle}>
                        จำนวน
                      </label>
                      <input
                        id={`opening-balance-line-${index}-quantity`}
                        inputMode="decimal"
                        value={line.quantity}
                        onChange={(e) => changeLine(index, { quantity: e.target.value })}
                        style={fieldInputStyle}
                      />
                    </div>
                    <div style={{ flex: '0 1 10rem' }}>
                      <label htmlFor={`opening-balance-line-${index}-unit`} style={fieldLabelStyle}>
                        {UNIT_LABEL}
                      </label>
                      <select id={`opening-balance-line-${index}-unit`} value={line.unit_id} onChange={(e) => changeLine(index, { unit_id: e.target.value })} style={fieldInputStyle}>
                        <option value="">-</option>
                        {line.units.map((unit) => (
                          <option key={unit.unit_id} value={unit.unit_id}>
                            {unit.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div style={{ flex: '1 1 10rem' }}>
                      <label htmlFor={`opening-balance-line-${index}-note`} style={fieldLabelStyle}>
                        หมายเหตุ
                      </label>
                      <input id={`opening-balance-line-${index}-note`} value={line.note} maxLength={500} onChange={(e) => changeLine(index, { note: e.target.value })} style={fieldInputStyle} />
                    </div>
                    <button
                      type="button"
                      id={`opening-balance-line-${index}-remove`}
                      onClick={() => setLines((current) => current.filter((_, at) => at !== index))}
                      style={{ padding: '0.5rem 0.75rem', backgroundColor: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.875rem' }}
                    >
                      นำออก
                    </button>
                  </div>
                ))}

                {lines.length < MAX_LINES && (
                  <div style={{ marginTop: '0.75rem', padding: '0.75rem', backgroundColor: '#f9fafb', borderRadius: '6px' }}>
                    <label htmlFor="opening-balance-stock-material-search" style={fieldLabelStyle}>
                      เพิ่ม{STOCK_MATERIAL_LABEL}
                    </label>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                      <input
                        id="opening-balance-stock-material-search"
                        type="search"
                        value={searchInput}
                        maxLength={500}
                        placeholder={`ค้นหาจากชื่อ${STOCK_MATERIAL_LABEL}`}
                        onChange={(e) => setSearchInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            setSearch(searchInput);
                          }
                        }}
                        style={{ ...fieldInputStyle, flex: '1 1 14rem', width: 'auto' }}
                      />
                      <button type="button" id="opening-balance-stock-material-search-submit" onClick={() => setSearch(searchInput)} style={{ padding: '0.5rem 1rem', backgroundColor: '#4b5563', color: '#ffffff', border: 'none', borderRadius: '6px', fontSize: '0.875rem' }}>
                        ค้นหา
                      </button>
                      <label htmlFor="opening-balance-include-inactive" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.875rem', color: '#374151' }}>
                        <input id="opening-balance-include-inactive" type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
                        รวมรายการที่{INACTIVE_LABEL}
                      </label>
                    </div>
                    {addError && (
                      <div role="alert" data-testid="opening-balance-add-error" style={{ marginTop: '0.5rem', color: '#991b1b', fontSize: '0.875rem' }}>
                        {addError}
                      </div>
                    )}
                    {choices.isError && (
                      <div role="alert" style={{ marginTop: '0.5rem', color: '#991b1b', fontSize: '0.875rem' }}>
                        ไม่สามารถค้นหา{STOCK_MATERIAL_LABEL}ได้
                      </div>
                    )}
                    {choices.data && (
                      <ul id="opening-balance-stock-material-choices" style={{ listStyle: 'none', padding: 0, margin: '0.5rem 0 0 0' }}>
                        {choices.data.items.length === 0 && <li style={{ fontSize: '0.875rem', color: '#6b7280' }}>ไม่พบ{STOCK_MATERIAL_LABEL}ที่ค้นหา</li>}
                        {choices.data.items.map((material) => (
                          <li key={material.id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.25rem 0', fontSize: '0.875rem' }}>
                            <span style={{ flex: 1 }}>
                              {material.name}
                              {!material.is_active && ` (${INACTIVE_LABEL})`}
                            </span>
                            <button
                              type="button"
                              data-testid={`opening-balance-choose-${material.id}`}
                              disabled={lines.some((line) => line.stock_material_id === material.id)}
                              onClick={() => void addLine(material.id)}
                              style={{ padding: '0.25rem 0.75rem', backgroundColor: '#2563eb', color: '#ffffff', border: 'none', borderRadius: '6px', fontSize: '0.875rem' }}
                            >
                              เพิ่ม
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </fieldset>
            )}
          </LoanSaveForm>
        )}
      </div>
    </main>
  );
};

/**
 * F010-T2 (#233): the Opening Balance Draft form, new ("เพิ่มยอดตั้งต้น") or an existing Draft ("แก้ไขร่าง"): ยอด ณ วันที่,
 * ที่มาของยอด, a note and up to 50 lines, each a Stock Material found by name (Inactive ones on request), a quantity, one
 * of its active Units and a note. It saves incomplete; the confirm on the Draft's page checks it all (#231 Q13, Q25).
 */
export const OpeningBalanceForm: React.FC = () => {
  const { id = null } = useParams();
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <OpeningBalanceFormContent id={id} />
    </QueryClientProvider>
  );
};
