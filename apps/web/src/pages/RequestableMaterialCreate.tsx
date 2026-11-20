import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LoanSaveForm } from '../components/LoanSaveForm';
import { fieldInputStyle, fieldLabelStyle } from '../components/ReferenceContextFields';
import { useCsrfToken, useUnitList } from '../components/materialQueries';
import { WHOLE_NUMBER_UNIT_LABEL } from '../components/materialFacts';
import { ADD_REQUESTABLE_MATERIAL_LABEL, REQUEST_UNIT_LABEL, REQUESTABLE_MATERIAL_LABEL, type RequestableMaterialNameTaken } from '../components/requestableMaterialFacts';

const fieldStyle: React.CSSProperties = { marginBottom: '0.75rem' };

const RequestableMaterialCreateContent: React.FC = () => {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [requestUnitId, setRequestUnitId] = useState('');
  // Whole-number-only by default (#202 Q5).
  const [wholeNumberOnly, setWholeNumberOnly] = useState(true);
  const [description, setDescription] = useState('');

  // The Unit list answers can_manage with material:manage, which creating a Requestable Material needs too.
  const units = useUnitList();
  const canManage = units.data?.can_manage === true && !units.isError;
  const session = useCsrfToken(canManage);
  // The form waits for the token: a request sent without it is refused as if the grant were gone (#135).
  const csrfToken = session.data ?? null;
  const mayCreate = canManage && csrfToken !== null;

  const isSignedOut = units.error?.status === 401;
  useEffect(() => {
    if (isSignedOut) {
      navigate('/login', { replace: true });
    }
  }, [isSignedOut, navigate]);

  // A new Request Unit is an active Unit of the list (#202 Q15).
  const activeUnits = (units.data?.items ?? []).filter((unit) => unit.is_active);

  const requestError = (): string | null => {
    if (name.trim() === '') {
      return 'กรุณากรอกชื่อ';
    }
    if (requestUnitId === '') {
      return `กรุณาเลือก${REQUEST_UNIT_LABEL}`;
    }
    return null;
  };

  const requestBody = () => ({
    name: name.trim(),
    request_unit_id: requestUnitId,
    whole_number_only: wholeNumberOnly,
    description: description.trim() || null,
  });

  // A name already used names the Requestable Material that holds it (#202 Q6); T7 offers reactivating an Inactive one.
  const nameTaken = (body: RequestableMaterialNameTaken | null) =>
    body?.code === 'DUPLICATE_NAME' ? (
      <span data-testid="requestable-material-name-taken">
        มี{REQUESTABLE_MATERIAL_LABEL}ชื่อนี้อยู่แล้ว:{' '}
        <Link to={`/requestable-materials/${body.entry.id}`} style={{ color: '#991b1b', fontWeight: 600 }}>
          {body.entry.name}
        </Link>
      </span>
    ) : null;

  return (
    <main style={{ minHeight: '100vh', backgroundColor: '#f3f4f6', padding: '1rem', fontFamily: 'system-ui, -apple-system, sans-serif', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: '800px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1)', padding: '1.25rem', boxSizing: 'border-box' }}>
        <Link to="/requestable-materials" id="back-requestable-material-list-link" style={{ color: '#4b5563', textDecoration: 'none', fontSize: '0.875rem', fontWeight: 500 }}>
          ← กลับสู่รายการ{REQUESTABLE_MATERIAL_LABEL}
        </Link>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: '1rem 0 1.5rem 0' }}>{ADD_REQUESTABLE_MATERIAL_LABEL}</h1>

        {units.isPending && (
          <div role="status" aria-busy="true" style={{ padding: '2rem', textAlign: 'center', color: '#6b7280', fontSize: '0.875rem' }}>
            กำลังโหลด...
          </div>
        )}
        {(units.isError && !isSignedOut) || (units.data && !canManage) ? (
          <div role="alert" id="requestable-material-create-forbidden" style={{ padding: '0.75rem 1rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            {units.error?.status && units.error.status !== 403 ? 'เกิดข้อผิดพลาดในการโหลดรายการหน่วยนับ' : `คุณไม่มีสิทธิ์เพิ่ม${REQUESTABLE_MATERIAL_LABEL}`}
          </div>
        ) : null}

        {mayCreate && (
          <LoanSaveForm
            idPrefix="requestable-material"
            heading={`ข้อมูล${REQUESTABLE_MATERIAL_LABEL}`}
            saveUrl="/requestable-materials"
            csrfToken={csrfToken}
            requestError={requestError}
            requestBody={requestBody}
            refusedList={nameTaken}
            forbiddenMessage={`คุณไม่มีสิทธิ์เพิ่ม${REQUESTABLE_MATERIAL_LABEL}`}
            refusedMessage={`ไม่สามารถเพิ่ม${REQUESTABLE_MATERIAL_LABEL}ได้`}
            onSaved={async (body) => {
              navigate(`/requestable-materials/${body.requestable_material_id}`);
            }}
            onCancel={() => navigate('/requestable-materials')}
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
                  <label htmlFor="requestable-material-name" style={fieldLabelStyle}>
                    ชื่อ เช่น กระดาษ A4
                  </label>
                  <input id="requestable-material-name" type="text" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} style={fieldInputStyle} />
                </div>
                <div style={fieldStyle}>
                  <label htmlFor="requestable-material-request-unit" style={fieldLabelStyle}>
                    {REQUEST_UNIT_LABEL}
                  </label>
                  <select id="requestable-material-request-unit" value={requestUnitId} onChange={(e) => setRequestUnitId(e.target.value)} style={fieldInputStyle}>
                    <option value="">-- เลือก{REQUEST_UNIT_LABEL} --</option>
                    {activeUnits.map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unit.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={fieldStyle}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', color: '#374151' }}>
                    <input id="requestable-material-whole-number-only" type="checkbox" checked={wholeNumberOnly} onChange={(e) => setWholeNumberOnly(e.target.checked)} />
                    {WHOLE_NUMBER_UNIT_LABEL}
                  </label>
                </div>
                <div style={fieldStyle}>
                  <label htmlFor="requestable-material-description" style={fieldLabelStyle}>
                    รายละเอียด (ไม่บังคับ)
                  </label>
                  <textarea id="requestable-material-description" value={description} maxLength={2000} rows={3} onChange={(e) => setDescription(e.target.value)} style={fieldInputStyle} />
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
 * "เพิ่มวัสดุสำหรับขอเบิก" (F009-T1): creates a Requestable Material with its name, Request Unit, whole-number setting and
 * description (#202 Q5); a name already used names the Requestable Material that holds it (Q6).
 */
export const RequestableMaterialCreate: React.FC = () => {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <RequestableMaterialCreateContent />
    </QueryClientProvider>
  );
};
