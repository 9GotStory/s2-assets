import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ListEntryAddField, ListEntrySelect } from '../components/ListEntryFields';
import { LoanSaveForm } from '../components/LoanSaveForm';
import {
  ADD_SOURCE_PARTY_LABEL,
  ADD_SOURCE_TYPE_LABEL,
  INACTIVE_LABEL,
  MATERIAL_RECEIPT_LABEL,
  SOURCE_PARTY_LABEL,
  SOURCE_TYPE_LABEL,
  STOCK_MATERIAL_LABEL,
  UNIT_LABEL,
  type StockMaterialDetail,
  type StockMaterialList,
} from '../components/materialFacts';
import { useCsrfToken, useSourcePartyList, useSourceTypeList } from '../components/materialQueries';
import {
  ADD_MATERIAL_RECEIPT_LABEL,
  AMOUNT_FOR_REFERENCE_LABEL,
  AMOUNT_LABEL,
  formatAmount,
  lineAmount,
  RECEIPT_REFERENCE_LABEL,
  RECEIVED_DATE_LABEL,
  UNIT_PRICE_LABEL,
  type MaterialReceiptDetail,
  type MaterialReceiptList,
} from '../components/materialReceiptFacts';
import { EDIT_DRAFT_LABEL, SAVE_DRAFT_LABEL } from '../components/openingBalanceFacts';
import { fieldInputStyle, fieldLabelStyle } from '../components/ReferenceContextFields';

// #231 Q9, P7: at most 50 lines; the Receipt Reference 500 characters, the note 2000 and a line's note 500.
const MAX_LINES = 50;
const CHOICES_PAGE_SIZE = 10;

// A line as the form holds it: its Stock Material with the Units it may be counted in, and what is typed.
interface DraftLine {
  // Tells the line apart from another line of the same Stock Material (Q9).
  key: string;
  stock_material_id: string;
  name: string;
  is_active: boolean;
  // The Stock Material's active Units (#231 Q11), and the chosen one even when no longer active.
  units: { unit_id: string; name: string }[];
  unit_id: string;
  quantity: string;
  unit_price: string;
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

const MaterialReceiptFormContent: React.FC<{ id: string | null }> = ({ id }) => {
  const navigate = useNavigate();
  const [receivedDate, setReceivedDate] = useState('');
  const [sourcePartyId, setSourcePartyId] = useState('');
  const [sourceTypeId, setSourceTypeId] = useState('');
  const [receiptReference, setReceiptReference] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [version, setVersion] = useState<number | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState<string | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // A new Draft asks the list whether the viewer may write; an existing one is read whole, its lines with their Units.
  const grant = useQuery<MaterialReceiptList, Error & { status?: number }>({
    queryKey: ['material-receipt-grant'],
    queryFn: ({ signal }) => readJson('/material-receipts?limit=1', signal),
    enabled: id === null,
  });
  const existing = useQuery<MaterialReceiptDetail, Error & { status?: number }>({
    queryKey: ['material-receipt', id],
    queryFn: ({ signal }) => readJson(`/material-receipts/${encodeURIComponent(id!)}`, signal),
    enabled: id !== null,
  });
  const sourceParties = useSourcePartyList();
  const sourceTypes = useSourceTypeList();
  useEffect(() => {
    const detail = existing.data;
    if (!detail || version !== null) {
      return;
    }
    setVersion(detail.version);
    setReceivedDate(detail.received_date ?? '');
    setSourcePartyId(detail.source_party?.id ?? '');
    setSourceTypeId(detail.source_type?.id ?? '');
    setReceiptReference(detail.receipt_reference ?? '');
    setNote(detail.note ?? '');
    void Promise.all(
      detail.lines.map(async (line) => ({
        key: line.id,
        stock_material_id: line.stock_material.id,
        ...(await unitsOf(line.stock_material.id, line.unit?.unit_id ?? null)),
        unit_id: line.unit?.unit_id ?? '',
        quantity: line.quantity ?? '',
        unit_price: line.unit_price ?? '',
        note: line.note ?? '',
      }))
    ).then(setLines, () => setAddError('ไม่สามารถโหลดหน่วยนับของวัสดุได้ กรุณาโหลดใหม่'));
  }, [existing.data, version]);

  const choices = useQuery<StockMaterialList, Error & { status?: number }>({
    queryKey: ['material-receipt-stock-material-choices', search, includeInactive],
    queryFn: ({ signal }) => {
      const query = new URLSearchParams({ limit: String(CHOICES_PAGE_SIZE), status: includeInactive ? 'all' : 'active' });
      // Runs only once a search is made (`enabled`).
      if (search!.trim() !== '') {
        query.set('search', search!.trim());
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

  // A Stock Material may come again in another of its Units (Q9): the new line takes the first Unit no line of it holds.
  const addLine = async (materialId: string) => {
    setAddError(null);
    try {
      const material = await unitsOf(materialId, null);
      setLines((current) => {
        const taken = new Set(current.filter((line) => line.stock_material_id === materialId).map((line) => line.unit_id));
        const unit = material.units.find((choice) => !taken.has(choice.unit_id));
        return [...current, { key: crypto.randomUUID(), stock_material_id: materialId, ...material, unit_id: unit?.unit_id ?? '', quantity: '', unit_price: '', note: '' }];
      });
    } catch {
      setAddError('ไม่สามารถโหลดหน่วยนับของวัสดุได้ กรุณาลองใหม่');
    }
  };
  const changeLine = (index: number, change: Partial<DraftLine>) => setLines((current) => current.map((line, at) => (at === index ? { ...line, ...change } : line)));

  // The amounts for reference only, worked out from what is typed and never stored (Q8).
  const amounts = lines.map((line) => lineAmount(line.quantity, line.unit_price));
  const total = amounts.some((amount) => amount !== null) ? amounts.reduce<bigint>((sum, amount) => sum + (amount ?? 0n), 0n) : null;

  const heading = id === null ? ADD_MATERIAL_RECEIPT_LABEL : EDIT_DRAFT_LABEL;
  return (
    <main style={{ minHeight: '100vh', backgroundColor: '#f3f4f6', padding: '1rem', fontFamily: 'system-ui, -apple-system, sans-serif', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1)', padding: '1.25rem', boxSizing: 'border-box' }}>
        <Link to={id === null ? '/material-receipts' : `/material-receipts/${id}`} id="back-material-receipt-link" style={{ color: '#4b5563', textDecoration: 'none', fontSize: '0.875rem', fontWeight: 500 }}>
          ← กลับสู่{MATERIAL_RECEIPT_LABEL}
        </Link>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: '1rem 0 1.5rem 0' }}>{heading}</h1>

        {loadError && !isSignedOut && (
          <div role="alert" id="material-receipt-form-load-error" style={{ padding: '0.75rem 1rem', marginBottom: '1rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            {loadError.status === 403 ? `คุณไม่มีสิทธิ์เข้าถึง${MATERIAL_RECEIPT_LABEL} (403 Forbidden)` : `เกิดข้อผิดพลาดในการโหลด${MATERIAL_RECEIPT_LABEL}`}
          </div>
        )}
        {!loadError && (grant.isSuccess || existing.isSuccess) && !mayManage && (
          <div role="alert" id="material-receipt-form-not-allowed" style={{ padding: '0.75rem 1rem', marginBottom: '1rem', borderRadius: '6px', backgroundColor: '#fef3c7', color: '#92400e', fontSize: '0.875rem' }}>
            {id === null ? `คุณไม่มีสิทธิ์บันทึก${MATERIAL_RECEIPT_LABEL}` : `แก้ไขได้เฉพาะร่างโดยผู้มีสิทธิ์บันทึก${MATERIAL_RECEIPT_LABEL}`}
          </div>
        )}
        {ready && (sourceParties.isError || sourceTypes.isError) && (
          <div role="alert" id="material-receipt-form-list-error" style={{ padding: '0.75rem 1rem', marginBottom: '1rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            ไม่สามารถโหลดรายการ{SOURCE_PARTY_LABEL}หรือ{SOURCE_TYPE_LABEL}ได้ กรุณาโหลดใหม่
          </div>
        )}

        {ready && (
          <LoanSaveForm
            idPrefix="material-receipt-draft"
            heading={heading}
            saveUrl={id === null ? '/material-receipts' : `/material-receipts/${encodeURIComponent(id)}`}
            method={id === null ? 'POST' : 'PUT'}
            csrfToken={csrfToken}
            requestError={() => null}
            requestBody={() => ({
              ...(id === null ? {} : { expected_version: version }),
              received_date: receivedDate === '' ? null : receivedDate,
              source_party_id: sourcePartyId === '' ? null : sourcePartyId,
              source_type_id: sourceTypeId === '' ? null : sourceTypeId,
              // The API trims free text and saves a blank one as none.
              receipt_reference: receiptReference,
              note,
              lines: lines.map((line) => ({
                stock_material_id: line.stock_material_id,
                unit_id: line.unit_id === '' ? null : line.unit_id,
                quantity: line.quantity.trim() === '' ? null : line.quantity.trim(),
                unit_price: line.unit_price.trim() === '' ? null : line.unit_price.trim(),
                note: line.note,
              })),
            })}
            refusedList={() => null}
            forbiddenMessage={`คุณไม่มีสิทธิ์บันทึก${MATERIAL_RECEIPT_LABEL}`}
            refusedMessage={`ไม่สามารถบันทึก${MATERIAL_RECEIPT_LABEL}ได้`}
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
              navigate(`/material-receipts/${body.material_receipt_id}`);
            }}
            onCancel={() => navigate(id === null ? '/material-receipts' : `/material-receipts/${id}`)}
          >
            {(isLocked) => (
              <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0', minWidth: 0 }}>
                <p style={{ fontSize: '0.875rem', color: '#4b5563', margin: '0 0 0.75rem 0' }}>บันทึกร่างได้แม้ยังกรอกไม่ครบ ระบบจะตรวจทั้งหมดอีกครั้งเมื่อยืนยัน</p>
                <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
                  <div style={{ flex: '0 1 12rem' }}>
                    <label htmlFor="material-receipt-received-date" style={fieldLabelStyle}>
                      {RECEIVED_DATE_LABEL}
                    </label>
                    <input id="material-receipt-received-date" type="date" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} style={fieldInputStyle} />
                  </div>
                  <div style={{ flex: '1 1 20rem' }}>
                    <label htmlFor="material-receipt-reference" style={fieldLabelStyle}>
                      {RECEIPT_REFERENCE_LABEL} (ไม่บังคับ)
                    </label>
                    <input
                      id="material-receipt-reference"
                      value={receiptReference}
                      maxLength={500}
                      placeholder="เช่น เลขที่และวันที่ของใบส่งของ"
                      onChange={(e) => setReceiptReference(e.target.value)}
                      style={fieldInputStyle}
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 20rem' }}>
                    <ListEntrySelect id="material-receipt-source-party" label={SOURCE_PARTY_LABEL} entries={sourceParties.data?.items ?? []} value={sourcePartyId} onChange={setSourcePartyId}>
                      <ListEntryAddField
                        id="material-receipt-new-source-party"
                        path="/source-parties"
                        concept={SOURCE_PARTY_LABEL}
                        addLabel={ADD_SOURCE_PARTY_LABEL}
                        placeholder="ชื่อแหล่งที่มาใหม่"
                        csrfToken={csrfToken}
                        disabled={isLocked}
                        onAdded={async (entry) => {
                          await sourceParties.refetch();
                          setSourcePartyId(entry.id);
                        }}
                      />
                    </ListEntrySelect>
                  </div>
                  <div style={{ flex: '1 1 20rem' }}>
                    <ListEntrySelect id="material-receipt-source-type" label={SOURCE_TYPE_LABEL} entries={sourceTypes.data?.items ?? []} value={sourceTypeId} onChange={setSourceTypeId}>
                      <ListEntryAddField
                        id="material-receipt-new-source-type"
                        path="/source-types"
                        concept={SOURCE_TYPE_LABEL}
                        addLabel={ADD_SOURCE_TYPE_LABEL}
                        placeholder="ชื่อวิธีได้มาใหม่"
                        csrfToken={csrfToken}
                        disabled={isLocked}
                        onAdded={async (entry) => {
                          await sourceTypes.refetch();
                          setSourceTypeId(entry.id);
                        }}
                      />
                    </ListEntrySelect>
                  </div>
                </div>
                <div style={{ marginBottom: '1rem' }}>
                  <label htmlFor="material-receipt-note" style={fieldLabelStyle}>
                    หมายเหตุ (ไม่บังคับ)
                  </label>
                  <textarea id="material-receipt-note" value={note} maxLength={2000} rows={2} onChange={(e) => setNote(e.target.value)} style={fieldInputStyle} />
                </div>

                <h2 style={{ fontSize: '1rem', fontWeight: 600, color: '#111827', margin: '0 0 0.5rem 0' }}>รายการ ({lines.length}/{MAX_LINES})</h2>
                {lines.map((line, index) => (
                  <div key={line.key} data-testid={`material-receipt-line-${index}`} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end', padding: '0.5rem 0', borderBottom: '1px solid #e5e7eb' }}>
                    <div style={{ flex: '1 1 12rem', fontSize: '0.875rem', color: '#111827', alignSelf: 'center' }}>
                      {line.name}
                      {!line.is_active && ` (${INACTIVE_LABEL})`}
                    </div>
                    <div style={{ flex: '0 1 7rem' }}>
                      <label htmlFor={`material-receipt-line-${index}-quantity`} style={fieldLabelStyle}>
                        จำนวน
                      </label>
                      <input
                        id={`material-receipt-line-${index}-quantity`}
                        inputMode="decimal"
                        value={line.quantity}
                        onChange={(e) => changeLine(index, { quantity: e.target.value })}
                        style={fieldInputStyle}
                      />
                    </div>
                    <div style={{ flex: '0 1 9rem' }}>
                      <label htmlFor={`material-receipt-line-${index}-unit`} style={fieldLabelStyle}>
                        {UNIT_LABEL}
                      </label>
                      <select id={`material-receipt-line-${index}-unit`} value={line.unit_id} onChange={(e) => changeLine(index, { unit_id: e.target.value })} style={fieldInputStyle}>
                        <option value="">-</option>
                        {line.units.map((unit) => (
                          <option key={unit.unit_id} value={unit.unit_id}>
                            {unit.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div style={{ flex: '0 1 8rem' }}>
                      <label htmlFor={`material-receipt-line-${index}-unit-price`} style={fieldLabelStyle}>
                        {UNIT_PRICE_LABEL}
                      </label>
                      <input
                        id={`material-receipt-line-${index}-unit-price`}
                        inputMode="decimal"
                        value={line.unit_price}
                        onChange={(e) => changeLine(index, { unit_price: e.target.value })}
                        style={fieldInputStyle}
                      />
                    </div>
                    <div style={{ flex: '0 1 8rem', fontSize: '0.875rem', color: '#374151', alignSelf: 'center' }}>
                      {AMOUNT_LABEL} <span data-testid={`material-receipt-line-${index}-amount`}>{amounts[index] === null ? '-' : formatAmount(amounts[index]!)}</span>
                    </div>
                    <div style={{ flex: '1 1 9rem' }}>
                      <label htmlFor={`material-receipt-line-${index}-note`} style={fieldLabelStyle}>
                        หมายเหตุ
                      </label>
                      <input id={`material-receipt-line-${index}-note`} value={line.note} maxLength={500} onChange={(e) => changeLine(index, { note: e.target.value })} style={fieldInputStyle} />
                    </div>
                    <button
                      type="button"
                      id={`material-receipt-line-${index}-remove`}
                      onClick={() => setLines((current) => current.filter((_, at) => at !== index))}
                      style={{ padding: '0.5rem 0.75rem', backgroundColor: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.875rem' }}
                    >
                      นำออก
                    </button>
                  </div>
                ))}
                {lines.length > 0 && (
                  <p style={{ fontSize: '0.875rem', color: '#374151', margin: '0.5rem 0 0 0' }}>
                    {AMOUNT_LABEL}รวม <strong data-testid="material-receipt-total-amount">{total === null ? '-' : formatAmount(total)}</strong> ({AMOUNT_FOR_REFERENCE_LABEL})
                  </p>
                )}

                {lines.length < MAX_LINES && (
                  <div style={{ marginTop: '0.75rem', padding: '0.75rem', backgroundColor: '#f9fafb', borderRadius: '6px' }}>
                    <label htmlFor="material-receipt-stock-material-search" style={fieldLabelStyle}>
                      เพิ่ม{STOCK_MATERIAL_LABEL}
                    </label>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                      <input
                        id="material-receipt-stock-material-search"
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
                      <button type="button" id="material-receipt-stock-material-search-submit" onClick={() => setSearch(searchInput)} style={{ padding: '0.5rem 1rem', backgroundColor: '#4b5563', color: '#ffffff', border: 'none', borderRadius: '6px', fontSize: '0.875rem' }}>
                        ค้นหา
                      </button>
                      <label htmlFor="material-receipt-include-inactive" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.875rem', color: '#374151' }}>
                        <input id="material-receipt-include-inactive" type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
                        รวมรายการที่{INACTIVE_LABEL}
                      </label>
                    </div>
                    {addError && (
                      <div role="alert" data-testid="material-receipt-add-error" style={{ marginTop: '0.5rem', color: '#991b1b', fontSize: '0.875rem' }}>
                        {addError}
                      </div>
                    )}
                    {choices.isError && (
                      <div role="alert" style={{ marginTop: '0.5rem', color: '#991b1b', fontSize: '0.875rem' }}>
                        ไม่สามารถค้นหา{STOCK_MATERIAL_LABEL}ได้
                      </div>
                    )}
                    {choices.data && (
                      <ul id="material-receipt-stock-material-choices" style={{ listStyle: 'none', padding: 0, margin: '0.5rem 0 0 0' }}>
                        {choices.data.items.length === 0 && <li style={{ fontSize: '0.875rem', color: '#6b7280' }}>ไม่พบ{STOCK_MATERIAL_LABEL}ที่ค้นหา</li>}
                        {choices.data.items.map((material) => (
                          <li key={material.id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.25rem 0', fontSize: '0.875rem' }}>
                            <span style={{ flex: 1 }}>
                              {material.name}
                              {!material.is_active && ` (${INACTIVE_LABEL})`}
                            </span>
                            <button
                              type="button"
                              data-testid={`material-receipt-choose-${material.id}`}
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
 * F010-T3 (#234): the Material Receipt Draft form, new ("เพิ่มรายการรับวัสดุ") or an existing Draft ("แก้ไขร่าง"): วันที่รับ,
 * แหล่งที่มา and วิธีได้มา (each with its inline add), เอกสารอ้างอิง, a note and up to 50 lines, each a Stock Material
 * found by name (Inactive ones on request), a quantity, one of its active Units, a ราคาต่อหน่วย and a note, a Stock
 * Material again only in another Unit. The amounts are for reference only. It saves incomplete; the confirm on the
 * Draft's page checks it all (#231 Q5–Q11, Q25).
 */
export const MaterialReceiptForm: React.FC = () => {
  const { id = null } = useParams();
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <MaterialReceiptFormContent id={id} />
    </QueryClientProvider>
  );
};
