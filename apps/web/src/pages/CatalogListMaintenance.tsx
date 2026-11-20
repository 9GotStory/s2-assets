import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider, type UseQueryResult } from '@tanstack/react-query';
import { LoanSaveForm } from '../components/LoanSaveForm';
import { fieldInputStyle, fieldLabelStyle } from '../components/ReferenceContextFields';
import {
  ACTIVE_LABEL,
  ADD_BRAND_LABEL,
  ADD_MATERIAL_CATEGORY_LABEL,
  ADD_UNIT_LABEL,
  BRAND_LABEL,
  CATALOG_LISTS_LABEL,
  INACTIVE_LABEL,
  MATERIAL_CATEGORY_LABEL,
  REACTIVATE_LABEL,
  RENAME_LABEL,
  UNIT_LABEL,
  type CatalogList,
  type ListEntry,
  type ListEntryHistoryEntry,
  type ListedEntry,
} from '../components/materialFacts';
import { useBrandList, useCsrfToken, useMaterialCategoryList, useUnitList } from '../components/materialQueries';

const THAI_DATE_TIME = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

// What a form shows when another write changed the entry since the page read it (#175 Q23).
const STALE_MESSAGE = 'มีผู้แก้ไขรายการนี้ไปแล้ว กรุณาโหลดใหม่';

const cellStyle: React.CSSProperties = { padding: '0.75rem 1rem', color: '#111827', verticalAlign: 'top' };
const headStyle: React.CSSProperties = { padding: '0.75rem 1rem', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' };
const actionStyle: React.CSSProperties = { padding: '0.25rem 0.625rem', backgroundColor: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.8125rem', marginRight: '0.5rem' };

// Each list on the page: the one its URL answers, what its entries are called and how one is added.
type ListKind = 'brand' | 'material-category' | 'unit';

interface ListSpec {
  kind: ListKind;
  path: string;
  concept: string;
  addLabel: string;
}

// The open form of a list: adding an entry, or a rename or a change of status of the entry `id`.
type OpenForm = { mode: 'add' } | { mode: 'rename'; id: string } | { mode: 'status'; id: string; action: 'inactivate' | 'reactivate' };

// What one history entry of a list entry says (#175 P6).
const historyLine = (concept: string, { action, changes }: ListEntryHistoryEntry): string => {
  if (action === 'CREATED') {
    return `เพิ่ม${concept} "${changes.name?.after}"`;
  }
  if (changes.name) {
    return `${RENAME_LABEL} "${changes.name.before}" เป็น "${changes.name.after}"`;
  }
  return changes.is_active?.after ? REACTIVATE_LABEL : INACTIVE_LABEL;
};

interface ListSectionProps {
  spec: ListSpec;
  list: UseQueryResult<CatalogList, Error & { status?: number }>;
}

/**
 * One list of the page (F008-T8, #183): its entries by name with their status, how many Stock Materials use each and
 * its history, and for holders of material:manage, adding an entry, its rename and หยุดใช้ / เปิดใช้อีกครั้ง (#175 P5).
 */
const ListSection: React.FC<ListSectionProps> = ({ spec, list }) => {
  const { kind, path, concept, addLabel } = spec;
  const [form, setForm] = useState<OpenForm | null>(null);
  const [name, setName] = useState('');
  const [saved, setSaved] = useState<string | null>(null);

  // A failed read hides what an earlier one showed: a lost grant fails closed.
  const data = list.isError ? undefined : list.data;
  const canManage = data?.can_manage === true;
  const session = useCsrfToken(canManage);
  const csrfToken = session.data ?? null;
  // The actions wait for the token: a request sent without it is refused as if the grant were gone (#135).
  const mayManage = canManage && csrfToken !== null;

  // The entry `id` as the list last read it: a form sends the version the page shows now, read again after a stale save.
  const entryOf = (id: string): ListedEntry | undefined => data?.items.find((entry) => entry.id === id);

  const open = (next: OpenForm | null) => {
    setForm(next);
    setName(next?.mode === 'rename' ? (entryOf(next.id)?.name ?? '') : '');
    setSaved(null);
  };

  const refresh = async () => (await list.refetch()).isSuccess;

  const done = (message: string) => async () => {
    await list.refetch();
    setForm(null);
    setSaved(message);
  };

  // The name a refused write found in the list, naming that entry; an Inactive one is offered for reactivation on
  // the add form (#175 Q20).
  const nameTaken = (body: any, offerReactivation: boolean): React.ReactNode => {
    if (body?.code !== 'DUPLICATE_NAME') {
      return null;
    }
    const entry: ListEntry = body.entry;
    if (entry.is_active) {
      return `มี${concept} "${entry.name}" อยู่ในรายการแล้ว`;
    }
    return (
      <>
        {`${concept} "${entry.name}" อยู่ในรายการแล้วแต่ถูก${INACTIVE_LABEL}`}
        {offerReactivation && (
          <button
            type="button"
            id={`${kind}-add-offer-reactivate`}
            onClick={() => {
              void list.refetch().then(() => open({ mode: 'status', id: entry.id, action: 'reactivate' }));
            }}
            style={{ ...actionStyle, marginLeft: '0.75rem' }}
          >
            {REACTIVATE_LABEL}
          </button>
        )}
      </>
    );
  };

  const nameField = (isLocked: boolean, label: string) => (
    <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0', minWidth: 0 }}>
      <label htmlFor={`${kind}-name`} style={fieldLabelStyle}>
        {label}
      </label>
      <input id={`${kind}-name`} type="text" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} style={fieldInputStyle} />
    </fieldset>
  );

  const renderForm = () => {
    if (form === null || !mayManage) {
      return null;
    }
    if (form.mode === 'add') {
      return (
        <LoanSaveForm
          idPrefix={`${kind}-add`}
          heading={addLabel}
          saveUrl={path}
          csrfToken={csrfToken}
          requestError={() => (name.trim() === '' ? `กรุณากรอกชื่อ${concept}` : null)}
          requestBody={() => ({ name: name.trim() })}
          refusedList={(body) => nameTaken(body, true)}
          forbiddenMessage={`คุณไม่มีสิทธิ์เพิ่ม${concept}`}
          refusedMessage={`ไม่สามารถเพิ่ม${concept}ได้`}
          submitLabel={addLabel}
          onSaved={async (entry) => done(`เพิ่ม${concept} "${entry?.name}" แล้ว`)()}
          onCancel={() => open(null)}
        >
          {(isLocked) => nameField(isLocked, `ชื่อ${concept}`)}
        </LoanSaveForm>
      );
    }
    const entry = entryOf(form.id);
    if (!entry) {
      return null;
    }
    if (form.mode === 'rename') {
      return (
        <LoanSaveForm
          idPrefix={`${kind}-rename`}
          heading={`${RENAME_LABEL}${concept} "${entry.name}"`}
          saveUrl={`${path}/${encodeURIComponent(entry.id)}/rename`}
          csrfToken={csrfToken}
          // The server compares the name as it stores it, trimmed (CODING_STANDARDS, an amend form).
          requestError={() => (name.trim() === '' ? `กรุณากรอกชื่อ${concept}ใหม่` : name.trim() === entry.name ? 'ชื่อใหม่ยังเหมือนชื่อเดิม' : null)}
          requestBody={() => ({ expected_version: entry.version, name: name.trim() })}
          refusedList={(body) => nameTaken(body, false)}
          forbiddenMessage={`คุณไม่มีสิทธิ์${RENAME_LABEL}${concept}`}
          refusedMessage={`ไม่สามารถ${RENAME_LABEL}${concept}ได้`}
          staleMessage={STALE_MESSAGE}
          submitLabel={RENAME_LABEL}
          onRefresh={refresh}
          onSaved={async (renamed) => done(`${RENAME_LABEL}เป็น "${renamed?.name}" แล้ว`)()}
          onCancel={() => open(null)}
        >
          {(isLocked) => (
            <>
              <p data-testid={`${kind}-rename-usage`} style={{ fontSize: '0.875rem', color: '#4b5563', margin: '0 0 0.75rem 0' }}>
                มีวัสดุใช้{concept}นี้อยู่ {entry.usage_count} รายการ ทุกรายการจะแสดงชื่อใหม่ ส่วนประวัติของวัสดุยังคงชื่อตามที่บันทึกไว้
              </p>
              {nameField(isLocked, `ชื่อ${concept}ใหม่`)}
            </>
          )}
        </LoanSaveForm>
      );
    }
    const inactivating = form.action === 'inactivate';
    return (
      <LoanSaveForm
        idPrefix={`${kind}-status`}
        heading={`${inactivating ? INACTIVE_LABEL : REACTIVATE_LABEL}${concept} "${entry.name}"`}
        saveUrl={`${path}/${encodeURIComponent(entry.id)}/${form.action}`}
        csrfToken={csrfToken}
        requestError={() => null}
        requestBody={() => ({ expected_version: entry.version })}
        refusedList={() => null}
        forbiddenMessage={`คุณไม่มีสิทธิ์เปลี่ยนสถานะ${concept}`}
        refusedMessage={`ไม่สามารถเปลี่ยนสถานะ${concept}ได้`}
        staleMessage={STALE_MESSAGE}
        submitLabel={inactivating ? INACTIVE_LABEL : REACTIVATE_LABEL}
        onRefresh={refresh}
        onSaved={async () => done(`${inactivating ? INACTIVE_LABEL : REACTIVATE_LABEL}${concept} "${entry.name}" แล้ว`)()}
        onCancel={() => open(null)}
      >
        {() => (
          <p data-testid={`${kind}-status-notice`} style={{ fontSize: '0.875rem', color: '#4b5563', margin: '0 0 1rem 0' }}>
            {inactivating
              ? `วัสดุ ${entry.usage_count} รายการที่ใช้${concept}นี้ยังแสดง${concept}นี้ตามเดิม แต่จะเลือกให้วัสดุอื่นไม่ได้จนกว่าจะ${REACTIVATE_LABEL}`
              : `${concept}นี้จะกลับมาให้เลือกได้อีกครั้งเป็นรายการเดิม`}
          </p>
        )}
      </LoanSaveForm>
    );
  };

  return (
    <section id={`catalog-list-${kind}`} aria-labelledby={`catalog-list-${kind}-heading`} style={{ marginBottom: '2rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', marginBottom: '0.75rem' }}>
        <h2 id={`catalog-list-${kind}-heading`} style={{ fontSize: '1.125rem', fontWeight: 600, color: '#111827', margin: 0 }}>
          {concept}
        </h2>
        {mayManage && form?.mode !== 'add' && (
          <button type="button" id={`${kind}-add`} onClick={() => open({ mode: 'add' })} style={actionStyle}>
            {addLabel}
          </button>
        )}
      </div>

      {list.isError && list.error.status !== 401 && (
        <div role="alert" id={`catalog-list-${kind}-error`} style={{ padding: '0.75rem 1rem', marginBottom: '1rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
          {list.error.status === 403 ? `คุณไม่มีสิทธิ์เข้าถึงรายการ${concept} (403 Forbidden)` : `เกิดข้อผิดพลาดในการโหลดรายการ${concept}`}
        </div>
      )}
      {list.isPending && (
        <div role="status" aria-busy="true" style={{ padding: '1rem', color: '#6b7280', fontSize: '0.875rem' }}>
          กำลังโหลดรายการ{concept}...
        </div>
      )}

      {saved && (
        <div role="status" data-testid={`catalog-list-${kind}-saved`} style={{ padding: '0.75rem 1rem', marginBottom: '1rem', borderRadius: '6px', backgroundColor: '#dcfce7', color: '#166534', fontSize: '0.875rem' }}>
          {saved}
        </div>
      )}

      {renderForm()}

      {data && data.items.length === 0 && <p style={{ fontSize: '0.875rem', color: '#6b7280' }}>ยังไม่มี{concept}ในรายการ</p>}
      {data && data.items.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>
                <th style={headStyle}>ชื่อ</th>
                <th style={headStyle}>สถานะ</th>
                <th style={headStyle}>วัสดุที่ใช้อยู่</th>
                <th style={headStyle}>ประวัติ</th>
                {mayManage && <th style={headStyle}>ดำเนินการ</th>}
              </tr>
            </thead>
            <tbody>
              {data.items.map((entry) => (
                <tr key={entry.id} id={`${kind}-entry-${entry.id}`} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={cellStyle} data-testid={`${kind}-name-${entry.id}`}>
                    {entry.name}
                  </td>
                  <td style={cellStyle} data-testid={`${kind}-status-${entry.id}`}>
                    {entry.is_active ? ACTIVE_LABEL : INACTIVE_LABEL}
                  </td>
                  <td style={cellStyle} data-testid={`${kind}-usage-${entry.id}`}>
                    {entry.usage_count} รายการ
                  </td>
                  <td style={cellStyle}>
                    <details id={`${kind}-history-${entry.id}`}>
                      <summary style={{ cursor: 'pointer', color: '#2563eb' }}>{entry.history.length} รายการ</summary>
                      <ol style={{ margin: '0.5rem 0 0 0', paddingLeft: '1.25rem' }}>
                        {entry.history.map((change) => (
                          <li key={change.version} style={{ marginBottom: '0.25rem' }}>
                            {historyLine(concept, change)} — <time dateTime={change.recorded_at}>{THAI_DATE_TIME.format(new Date(change.recorded_at))}</time> โดย{' '}
                            {change.actor_username}
                          </li>
                        ))}
                      </ol>
                    </details>
                  </td>
                  {mayManage && (
                    <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
                      <button type="button" id={`${kind}-rename-${entry.id}`} onClick={() => open({ mode: 'rename', id: entry.id })} style={actionStyle}>
                        {RENAME_LABEL}
                      </button>
                      {entry.is_active ? (
                        <button type="button" id={`${kind}-inactivate-${entry.id}`} onClick={() => open({ mode: 'status', id: entry.id, action: 'inactivate' })} style={actionStyle}>
                          {INACTIVE_LABEL}
                        </button>
                      ) : (
                        <button type="button" id={`${kind}-reactivate-${entry.id}`} onClick={() => open({ mode: 'status', id: entry.id, action: 'reactivate' })} style={actionStyle}>
                          {REACTIVATE_LABEL}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};

const CatalogListMaintenanceContent: React.FC = () => {
  const navigate = useNavigate();
  const brands = useBrandList();
  const materialCategories = useMaterialCategoryList();
  const units = useUnitList();

  const isSignedOut = [brands, materialCategories, units].some((list) => list.error?.status === 401);
  useEffect(() => {
    if (isSignedOut) {
      navigate('/login', { replace: true });
    }
  }, [isSignedOut, navigate]);

  return (
    <main style={{ minHeight: '100vh', backgroundColor: '#f3f4f6', padding: '1rem', fontFamily: 'system-ui, -apple-system, sans-serif', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: '1000px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1)', padding: '1.25rem', boxSizing: 'border-box' }}>
        <Link to="/stock-materials" id="back-stock-material-list-link" style={{ color: '#4b5563', textDecoration: 'none', fontSize: '0.875rem', fontWeight: 500 }}>
          ← กลับสู่รายการวัสดุ
        </Link>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: '1rem 0 0.5rem 0' }}>{CATALOG_LISTS_LABEL}</h1>
        <p style={{ fontSize: '0.875rem', color: '#4b5563', margin: '0 0 1.5rem 0' }}>
          {RENAME_LABEL}เพื่อแก้การสะกดเท่านั้น รายการที่{INACTIVE_LABEL}ยังแสดงบนวัสดุที่ใช้อยู่ แต่เลือกให้วัสดุใหม่ไม่ได้ ไม่มีการลบหรือรวมรายการ
        </p>
        <ListSection spec={{ kind: 'brand', path: '/brands', concept: BRAND_LABEL, addLabel: ADD_BRAND_LABEL }} list={brands} />
        <ListSection spec={{ kind: 'material-category', path: '/material-categories', concept: MATERIAL_CATEGORY_LABEL, addLabel: ADD_MATERIAL_CATEGORY_LABEL }} list={materialCategories} />
        <ListSection spec={{ kind: 'unit', path: '/units', concept: UNIT_LABEL, addLabel: ADD_UNIT_LABEL }} list={units} />
      </div>
    </main>
  );
};

/**
 * "ยี่ห้อ หมวดวัสดุ และหน่วยนับ" (F008-T8, #183): the maintenance page of the Brand, Material Category and Unit lists in
 * the "วัสดุ" menu (#175 P5). A Supply Officer adds an entry, renames one to normalize its spelling, or makes it
 * Inactive and reactivates it; nothing is deleted, merged or aliased (MC-12, MC-26, Q19, Q20, Q21). Other holders of
 * material:view read the lists.
 */
export const CatalogListMaintenance: React.FC = () => {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <CatalogListMaintenanceContent />
    </QueryClientProvider>
  );
};
