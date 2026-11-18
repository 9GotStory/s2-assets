import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { LoanSaveForm } from '../components/LoanSaveForm';
import { fieldInputStyle, fieldLabelStyle } from '../components/ReferenceContextFields';
import {
  ADD_STOCK_MATERIAL_LABEL,
  ADD_UNIT_LABEL,
  BASE_UNIT_LABEL,
  MODEL_LABEL,
  SPECIFICATION_LABEL,
  STOCK_MATERIAL_LABEL,
  WHOLE_NUMBER_UNIT_LABEL,
  type UnitEntry,
  type UnitList,
} from '../components/materialFacts';

const fieldStyle: React.CSSProperties = { marginBottom: '0.75rem' };

// What adding a Unit from the form ended in: nothing yet, a message to show, or the request still out.
type UnitAddState = { status: 'idle' } | { status: 'sending' } | { status: 'message'; text: string; isError: boolean };

/**
 * Adds a Unit straight from the Stock Material form (#175 Q15, P5) and chooses it. A name already in the list is
 * chosen instead when it is active; an Inactive one is reactivated from the maintenance page (F008-T8).
 */
const UnitAddField: React.FC<{ csrfToken: string | null; disabled: boolean; onAdded: (unit: UnitEntry) => Promise<void> }> = ({ csrfToken, disabled, onAdded }) => {
  const [name, setName] = useState('');
  const [state, setState] = useState<UnitAddState>({ status: 'idle' });

  const add = async () => {
    if (name.trim() === '') {
      setState({ status: 'message', text: 'กรุณากรอกชื่อหน่วยนับ', isError: true });
      return;
    }
    setState({ status: 'sending' });
    const retryToken = crypto.randomUUID();
    let res: Response;
    try {
      res = await fetch('/units', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-retry-token': retryToken, ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
        credentials: 'include',
        body: JSON.stringify({ name: name.trim(), retry_token: retryToken }),
      });
    } catch {
      setState({ status: 'message', text: 'เกิดข้อผิดพลาดในการเชื่อมต่อเครือข่าย กรุณาลองใหม่', isError: true });
      return;
    }
    const body = await res.json().catch(() => null);
    if (res.status === 201) {
      await onAdded(body);
      setName('');
      setState({ status: 'message', text: `เพิ่มหน่วยนับ "${body.name}" แล้ว`, isError: false });
      return;
    }
    if (res.status === 409 && body?.code === 'DUPLICATE_NAME' && body.entry) {
      const entry: UnitEntry = body.entry;
      if (entry.is_active) {
        await onAdded(entry);
        setName('');
        setState({ status: 'message', text: `มีหน่วยนับ "${entry.name}" อยู่แล้ว เลือกให้แล้ว`, isError: false });
      } else {
        setState({ status: 'message', text: `หน่วยนับ "${entry.name}" ถูกหยุดใช้อยู่ ใช้ไม่ได้จนกว่าจะเปิดใช้อีกครั้ง`, isError: true });
      }
      return;
    }
    setState({ status: 'message', text: body?.message || 'ไม่สามารถเพิ่มหน่วยนับได้', isError: true });
  };

  return (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.5rem' }}>
      <label htmlFor="stock-material-new-unit" style={{ fontSize: '0.875rem', color: '#4b5563' }}>
        ไม่มีในรายการ:
      </label>
      <input
        id="stock-material-new-unit"
        type="text"
        value={name}
        maxLength={200}
        placeholder="ชื่อหน่วยนับใหม่ เช่น รีม"
        disabled={disabled || state.status === 'sending'}
        onChange={(e) => setName(e.target.value)}
        style={{ ...fieldInputStyle, width: 'auto', flex: '1 1 10rem' }}
      />
      <button
        type="button"
        id="stock-material-new-unit-add"
        disabled={disabled || state.status === 'sending'}
        onClick={() => void add()}
        style={{ padding: '0.5rem 0.875rem', backgroundColor: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.875rem' }}
      >
        {ADD_UNIT_LABEL}
      </button>
      {state.status === 'message' && (
        <span role={state.isError ? 'alert' : 'status'} data-testid="stock-material-new-unit-message" style={{ flexBasis: '100%', fontSize: '0.875rem', color: state.isError ? '#991b1b' : '#166534' }}>
          {state.text}
        </span>
      )}
    </div>
  );
};

const StockMaterialCreateContent: React.FC = () => {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [specification, setSpecification] = useState('');
  const [note, setNote] = useState('');
  const [baseUnitId, setBaseUnitId] = useState('');
  const [wholeNumberOnly, setWholeNumberOnly] = useState(true);

  const units = useQuery<UnitList, Error & { status?: number }>({
    queryKey: ['units'],
    queryFn: async ({ signal }) => {
      const res = await fetch('/units', { credentials: 'include', signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
  });
  const canManage = units.data?.can_manage === true && !units.isError;
  const session = useQuery<string | null>({
    queryKey: ['stock-material-session'],
    queryFn: async ({ signal }) => {
      const res = await fetch('/auth/session-check', { credentials: 'include', signal });
      return res.ok ? ((await res.json()).csrfToken ?? null) : null;
    },
    enabled: canManage,
  });
  // The form waits for the token: a request sent without it is refused as if the grant were gone.
  const csrfToken = session.data ?? null;

  const isSignedOut = units.error?.status === 401;
  useEffect(() => {
    if (isSignedOut) {
      navigate('/login', { replace: true });
    }
  }, [isSignedOut, navigate]);

  // Only active Units are offered for a new choice (#175 Q21).
  const activeUnits = (units.data?.items ?? []).filter((unit) => unit.is_active);

  const requestError = (): string | null => {
    if (name.trim() === '') {
      return 'กรุณากรอกชื่อวัสดุ';
    }
    if (baseUnitId === '') {
      return `กรุณาเลือก${BASE_UNIT_LABEL}`;
    }
    return null;
  };

  const requestBody = () => ({
    name: name.trim(),
    model: model.trim() || null,
    specification: specification.trim() || null,
    note: note.trim() || null,
    base_unit: { unit_id: baseUnitId, whole_number_only: wholeNumberOnly },
  });

  return (
    <main style={{ minHeight: '100vh', backgroundColor: '#f3f4f6', padding: '1rem', fontFamily: 'system-ui, -apple-system, sans-serif', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: '800px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1)', padding: '1.25rem', boxSizing: 'border-box' }}>
        <Link to="/stock-materials" id="back-stock-material-list-link" style={{ color: '#4b5563', textDecoration: 'none', fontSize: '0.875rem', fontWeight: 500 }}>
          ← กลับสู่รายการ{STOCK_MATERIAL_LABEL}
        </Link>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: '1rem 0 1.5rem 0' }}>{ADD_STOCK_MATERIAL_LABEL}</h1>

        {units.isPending && (
          <div role="status" aria-busy="true" style={{ padding: '2rem', textAlign: 'center', color: '#6b7280', fontSize: '0.875rem' }}>
            กำลังโหลด...
          </div>
        )}
        {(units.isError && !isSignedOut) || (units.data && !canManage) ? (
          <div role="alert" id="stock-material-create-forbidden" style={{ padding: '0.75rem 1rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            {units.error?.status && units.error.status !== 403 ? 'เกิดข้อผิดพลาดในการโหลดรายการหน่วยนับ' : 'คุณไม่มีสิทธิ์เพิ่มวัสดุ'}
          </div>
        ) : null}

        {canManage && (
          <LoanSaveForm
            idPrefix="stock-material"
            heading="ข้อมูลวัสดุ"
            saveUrl="/stock-materials"
            csrfToken={csrfToken}
            requestError={requestError}
            requestBody={requestBody}
            refusedList={() => null}
            forbiddenMessage="คุณไม่มีสิทธิ์เพิ่มวัสดุ"
            refusedMessage="ไม่สามารถเพิ่มวัสดุได้"
            onSaved={async (body) => {
              navigate(`/stock-materials/${body.stock_material_id}`);
            }}
            onCancel={() => navigate('/stock-materials')}
            onPermissionRevoked={(status) => {
              if (status === 401) {
                navigate('/login', { replace: true });
                return;
              }
              void units.refetch();
            }}
          >
            {(isLocked) => (
              <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0', minWidth: 0 }}>
                <div style={fieldStyle}>
                  <label htmlFor="stock-material-name" style={fieldLabelStyle}>
                    ชื่อวัสดุ
                  </label>
                  <input id="stock-material-name" type="text" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} style={fieldInputStyle} />
                </div>
                <div style={fieldStyle}>
                  <label htmlFor="stock-material-model" style={fieldLabelStyle}>
                    {MODEL_LABEL} (ไม่บังคับ)
                  </label>
                  <input id="stock-material-model" type="text" value={model} maxLength={200} onChange={(e) => setModel(e.target.value)} style={fieldInputStyle} />
                </div>
                <div style={fieldStyle}>
                  <label htmlFor="stock-material-specification" style={fieldLabelStyle}>
                    {SPECIFICATION_LABEL} เช่น ขนาด สี เกรด (ไม่บังคับ)
                  </label>
                  <textarea id="stock-material-specification" value={specification} maxLength={500} rows={2} onChange={(e) => setSpecification(e.target.value)} style={fieldInputStyle} />
                </div>
                <div style={fieldStyle}>
                  <label htmlFor="stock-material-note" style={fieldLabelStyle}>
                    หมายเหตุ (ไม่บังคับ)
                  </label>
                  <textarea id="stock-material-note" value={note} maxLength={2000} rows={3} onChange={(e) => setNote(e.target.value)} style={fieldInputStyle} />
                </div>
                <fieldset style={{ border: '1px solid #e5e7eb', borderRadius: '6px', padding: '0.75rem', margin: '0 0 0.75rem 0', minWidth: 0 }}>
                  <legend style={{ fontSize: '0.875rem', fontWeight: 600, color: '#374151' }}>{BASE_UNIT_LABEL}</legend>
                  <label htmlFor="stock-material-base-unit" style={{ position: 'absolute', left: '-9999px' }}>
                    {BASE_UNIT_LABEL}
                  </label>
                  <select id="stock-material-base-unit" value={baseUnitId} onChange={(e) => setBaseUnitId(e.target.value)} style={fieldInputStyle}>
                    <option value="">-- เลือก{BASE_UNIT_LABEL} --</option>
                    {activeUnits.map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unit.name}
                      </option>
                    ))}
                  </select>
                  <UnitAddField
                    csrfToken={csrfToken}
                    disabled={isLocked || csrfToken === null}
                    onAdded={async (unit) => {
                      await units.refetch();
                      setBaseUnitId(unit.id);
                    }}
                  />
                  <label style={{ display: 'block', marginTop: '0.75rem', fontSize: '0.875rem', color: '#111827' }}>
                    <input id="stock-material-base-unit-whole" type="checkbox" checked={wholeNumberOnly} onChange={(e) => setWholeNumberOnly(e.target.checked)} /> {WHOLE_NUMBER_UNIT_LABEL}
                  </label>
                </fieldset>
              </fieldset>
            )}
          </LoanSaveForm>
        )}
      </div>
    </main>
  );
};

/** "เพิ่มวัสดุ" (F008-T1): creates a Stock Material with its Base Unit, adding a missing Unit straight from the form. */
export const StockMaterialCreate: React.FC = () => {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <StockMaterialCreateContent />
    </QueryClientProvider>
  );
};
