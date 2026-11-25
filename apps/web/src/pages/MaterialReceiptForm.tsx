import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ListEntryAddField, ListEntrySelect } from '../components/ListEntryFields';
import { LoanSaveForm } from '../components/LoanSaveForm';
import {
  ADD_SOURCE_PARTY_LABEL,
  ADD_SOURCE_TYPE_LABEL,
  CONVERSION_FACTOR_LABEL,
  conversionLine,
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
  RECALCULATE_LABEL,
  RECEIPT_CORRECTION_LABEL,
  RECEIPT_REFERENCE_LABEL,
  RECEIVED_DATE_LABEL,
  UNIT_PRICE_LABEL,
  VOID_LINE_LABEL,
  VOIDED_LINE_LABEL,
  type MaterialReceiptDetail,
  type MaterialReceiptLine,
  type MaterialReceiptList,
  type ReceiptConfirmProblem,
} from '../components/materialReceiptFacts';
import { EDIT_DRAFT_LABEL, openingBalanceNumberLine, SAVE_DRAFT_LABEL } from '../components/openingBalanceFacts';
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
  // Each of the Stock Material's Units by id, with its name and today's Conversion Factor, and its Base Unit's name.
  catalog: Record<string, { name: string; conversion_factor: string | null }>;
  base_name: string;
  // F010-T6 (#237), in a Receipt Correction: the Receipt Line it is (null for a line added), its place, what it
  // recorded, whether this correction voids it, and whether it takes today's Conversion Factor (#231 Q18, Q29).
  line_id: string | null;
  position: number | null;
  recorded: { stock_material_id: string; unit_id: string; conversion_factor: string } | null;
  voided: boolean;
  recalculate: boolean;
}

// A line a Receipt Correction keeps with its Stock Material and Unit as recorded, so its Conversion Snapshot holds
// unless it is recalculated (#237 start decision 4).
const keepsPair = (line: DraftLine): boolean => line.recorded !== null && line.recorded.stock_material_id === line.stock_material_id && line.recorded.unit_id === line.unit_id;

// The Conversion Factor the line will be recorded at, as "1 <Unit> = <factor> <Base Unit>": its snapshot while it
// keeps its pair, otherwise today's factor of its Unit (#231 Q29). Null with no Unit chosen. A correction offers an
// active Unit or the line's own, and either has a factor: PostgreSQL keeps one blank only on an Inactive Unit
// (stock_material_units_factor_known_unless_inactive), and a Units write blanks none of a Stock Material with Stock
// Movements (F010-T5).
const factorLine = (line: DraftLine): string | null => {
  const unit = line.catalog[line.unit_id];
  if (unit === undefined) {
    return null;
  }
  const factor = keepsPair(line) && !line.recalculate ? line.recorded!.conversion_factor : unit.conversion_factor!;
  return conversionLine(unit.name, factor, line.base_name);
};

// A refusal names a line by its place in the request, `lines[<i>]`: the form names it by its number (ลำดับ).
const problemLine = (problem: ReceiptConfirmProblem, positions: number[]): string => {
  const line = /^lines\[(\d+)\]/.exec(problem.field);
  return line === null ? problem.message : `รายการที่ ${positions[Number(line[1])] + 1}: ${problem.message}`;
};

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
const unitsOf = async (id: string, kept: string | null): Promise<Pick<DraftLine, 'name' | 'is_active' | 'units' | 'catalog' | 'base_name'>> => {
  const material = await readJson<StockMaterialDetail>(`/stock-materials/${encodeURIComponent(id)}`);
  return {
    name: material.name,
    is_active: material.is_active,
    units: material.units.filter((unit) => unit.is_active || unit.unit_id === kept).map(({ unit_id, name, is_active }) => ({ unit_id, name: is_active ? name : `${name} (${INACTIVE_LABEL})` })),
    catalog: Object.fromEntries(material.units.map(({ unit_id, name, conversion_factor }) => [unit_id, { name, conversion_factor }])),
    // Every Stock Material has its Base Unit (#175).
    base_name: material.units.find((unit) => unit.is_base)!.name,
  };
};

// A recorded line's pair and Conversion Snapshot: a Received one's, which a Receipt Correction reads, from its Stock
// Movement in effect; a Draft's line has none.
const recordedOf = (line: MaterialReceiptLine): DraftLine['recorded'] => {
  const movement = line.stock_movements.find((recorded) => recorded.id === line.stock_movement_id);
  return movement === undefined ? null : { stock_material_id: line.stock_material.id, unit_id: movement.original_unit.unit_id, conversion_factor: movement.conversion_factor };
};

const MaterialReceiptFormContent: React.FC<{ id: string | null; correcting: boolean }> = ({ id, correcting }) => {
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
  // F010-T6 (#237), in a Receipt Correction: its reason, the lines voided before it, shown and never sent, the line
  // whose Stock Material a search replaces, and the place of each line sent, which a refusal names.
  const [reason, setReason] = useState('');
  const [voidedBefore, setVoidedBefore] = useState<MaterialReceiptLine[]>([]);
  const [replacing, setReplacing] = useState<number | null>(null);
  const sentPositions = useRef<number[]>([]);

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
    setVoidedBefore(detail.lines.filter((line) => line.is_voided));
    void Promise.all(
      detail.lines.filter((line) => !line.is_voided).map(async (line) => ({
        key: line.id,
        stock_material_id: line.stock_material.id,
        ...(await unitsOf(line.stock_material.id, line.unit?.unit_id ?? null)),
        unit_id: line.unit?.unit_id ?? '',
        quantity: line.quantity ?? '',
        unit_price: line.unit_price ?? '',
        note: line.note ?? '',
        line_id: line.id,
        position: line.position,
        recorded: recordedOf(line),
        voided: false,
        recalculate: false,
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

  // A Draft is edited; a Received Material Receipt only corrected (F010-T6, #237).
  const mayManage = id === null ? grant.data?.can_manage === true : existing.data?.can_manage === true && existing.data.state === (correcting ? 'RECEIVED' : 'DRAFT');
  const session = useCsrfToken(mayManage);
  const csrfToken = session.data ?? null;
  const ready = mayManage && csrfToken !== null && (id === null || version !== null);

  // A Stock Material may come again in another of its Units (Q9): the new line takes the first Unit no line of it holds,
  // a voided one included (#237 start decision 1). In a Receipt Correction, a search may instead replace the Stock
  // Material of the line `replacing`, which then takes its first such Unit at today's Conversion Factor.
  const addLine = async (materialId: string) => {
    setAddError(null);
    try {
      const material = await unitsOf(materialId, null);
      setLines((current) => {
        const taken = new Set(
          [...current.filter((_, at) => at !== replacing), ...voidedBefore.map((line) => ({ stock_material_id: line.stock_material.id, unit_id: line.unit?.unit_id }))]
            .filter((line) => line.stock_material_id === materialId)
            .map((line) => line.unit_id)
        );
        const unit_id = material.units.find((choice) => !taken.has(choice.unit_id))?.unit_id ?? '';
        if (replacing !== null) {
          return current.map((line, at) => (at === replacing ? { ...line, stock_material_id: materialId, ...material, unit_id, recalculate: false } : line));
        }
        const added: DraftLine = { key: crypto.randomUUID(), stock_material_id: materialId, ...material, unit_id, quantity: '', unit_price: '', note: '', line_id: null, position: null, recorded: null, voided: false, recalculate: false };
        return [...current, added];
      });
      setReplacing(null);
    } catch {
      setAddError('ไม่สามารถโหลดหน่วยนับของวัสดุได้ กรุณาลองใหม่');
    }
  };
  const changeLine = (index: number, change: Partial<DraftLine>) => setLines((current) => current.map((line, at) => (at === index ? { ...line, ...change } : line)));

  // F010-T6 (#237): a line added in a Receipt Correction takes the next place after every line, voided ones included.
  const nextPosition = Math.max(-1, ...voidedBefore.map((line) => line.position), ...lines.map((line) => line.position ?? -1)) + 1;
  let added = 0;
  const positions = lines.map((line) => line.position ?? nextPosition + added++);
  const lineCount = lines.length + voidedBefore.length;

  // The amounts for reference only, worked out from what is typed and never stored (Q8); a voided line has none.
  const amounts = lines.map((line) => (line.voided ? null : lineAmount(line.quantity, line.unit_price)));
  const total = amounts.some((amount) => amount !== null) ? amounts.reduce<bigint>((sum, amount) => sum + (amount ?? 0n), 0n) : null;

  const heading = id === null ? ADD_MATERIAL_RECEIPT_LABEL : correcting ? RECEIPT_CORRECTION_LABEL : EDIT_DRAFT_LABEL;
  // The whole Material Receipt as it should be (#231 P5): each line kept, by its id, or added, the lines it voids, and
  // the reason.
  const correction = () => {
    const kept = lines.filter((line) => !line.voided);
    sentPositions.current = kept.map((line) => positions[lines.indexOf(line)]);
    return {
      expected_version: version,
      received_date: receivedDate,
      source_party_id: sourcePartyId === '' ? null : sourcePartyId,
      source_type_id: sourceTypeId === '' ? null : sourceTypeId,
      // The API trims free text and saves a blank one as none.
      receipt_reference: receiptReference,
      note,
      // A line added has no line_id (null).
      lines: kept.map((line) => ({
        line_id: line.line_id,
        stock_material_id: line.stock_material_id,
        unit_id: line.unit_id,
        quantity: line.quantity.trim(),
        unit_price: line.unit_price.trim() === '' ? null : line.unit_price.trim(),
        note: line.note,
        recalculate: line.recalculate,
      })),
      voided_line_ids: lines.filter((line) => line.voided).map((line) => line.line_id),
      reason,
    };
  };
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
            {id === null
              ? `คุณไม่มีสิทธิ์บันทึก${MATERIAL_RECEIPT_LABEL}`
              : correcting
                ? `${RECEIPT_CORRECTION_LABEL}ได้เฉพาะ${MATERIAL_RECEIPT_LABEL}ที่รับแล้ว โดยผู้มีสิทธิ์บันทึก${MATERIAL_RECEIPT_LABEL}`
                : `แก้ไขได้เฉพาะร่างโดยผู้มีสิทธิ์บันทึก${MATERIAL_RECEIPT_LABEL}`}
          </div>
        )}
        {ready && (sourceParties.isError || sourceTypes.isError) && (
          <div role="alert" id="material-receipt-form-list-error" style={{ padding: '0.75rem 1rem', marginBottom: '1rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            ไม่สามารถโหลดรายการ{SOURCE_PARTY_LABEL}หรือ{SOURCE_TYPE_LABEL}ได้ กรุณาโหลดใหม่
          </div>
        )}

        {ready && (
          <LoanSaveForm
            idPrefix={correcting ? 'material-receipt-correction' : 'material-receipt-draft'}
            heading={heading}
            saveUrl={id === null ? '/material-receipts' : `/material-receipts/${encodeURIComponent(id)}${correcting ? '/correct' : ''}`}
            method={id === null || correcting ? 'POST' : 'PUT'}
            csrfToken={csrfToken}
            requestError={() => {
              if (!correcting) {
                return null;
              }
              if (lines.some((line) => !line.voided && (line.unit_id === '' || line.quantity.trim() === ''))) {
                return `กรุณาเลือก${UNIT_LABEL}และกรอกจำนวนให้ครบทุกรายการ`;
              }
              return reason.trim() === '' ? 'กรุณากรอกเหตุผลที่แก้ไข' : null;
            }}
            requestBody={() => (correcting ? correction() : {
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
            // A Receipt Correction refused names every failing rule, a line's by its number (#231 Q25); a Draft's save
            // is never refused with problems.
            refusedList={(body) =>
              Array.isArray(body?.problems) ? (
                <>
                  <p style={{ margin: '0 0 0.5rem 0' }}>ยังบันทึกการแก้ไขไม่ได้ กรุณาแก้ตามรายการนี้</p>
                  <ul data-testid="material-receipt-correction-problems" style={{ margin: 0, paddingLeft: '1.25rem' }}>
                    {(body!.problems as ReceiptConfirmProblem[]).map((problem, index) => (
                      <li key={index}>
                        {problemLine(problem, sentPositions.current)}
                        {problem.in_effect_opening_balance && (
                          <>
                            {' '}
                            (<Link to={`/opening-balances/${problem.in_effect_opening_balance.opening_balance_id}`}>{openingBalanceNumberLine(problem.in_effect_opening_balance.opening_balance_number)}</Link>)
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null
            }
            forbiddenMessage={`คุณไม่มีสิทธิ์บันทึก${MATERIAL_RECEIPT_LABEL}`}
            refusedMessage={`ไม่สามารถบันทึก${MATERIAL_RECEIPT_LABEL}ได้`}
            staleMessage={correcting ? `มีผู้แก้ไข${MATERIAL_RECEIPT_LABEL}นี้ไปแล้ว กรุณาโหลดใหม่` : 'มีผู้แก้ไขร่างนี้ไปแล้ว กรุณาโหลดใหม่'}
            submitLabel={correcting ? 'บันทึกการแก้ไข' : SAVE_DRAFT_LABEL}
            onRefresh={
              id === null
                ? undefined
                : // The form reads the Material Receipt again once the new read is in: cleared first, it would read back
                  // the one it holds (F010-T6, #237).
                  async () => {
                    const fresh = await existing.refetch();
                    if (fresh.isSuccess) {
                      setVersion(null);
                    }
                    return fresh.isSuccess;
                  }
            }
            onSaved={async (body) => {
              navigate(`/material-receipts/${body.material_receipt_id}`);
            }}
            onCancel={() => navigate(id === null ? '/material-receipts' : `/material-receipts/${id}`)}
          >
            {(isLocked) => (
              <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0', minWidth: 0 }}>
                <p style={{ fontSize: '0.875rem', color: '#4b5563', margin: '0 0 0.75rem 0' }}>
                  {correcting
                    ? 'การแก้ไขที่เปลี่ยนคงเหลือจะบันทึกกลับรายการและรายการเคลื่อนไหวใหม่ โดยไม่ลบรายการเดิม'
                    : 'บันทึกร่างได้แม้ยังกรอกไม่ครบ ระบบจะตรวจทั้งหมดอีกครั้งเมื่อยืนยัน'}
                </p>
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

                <h2 style={{ fontSize: '1rem', fontWeight: 600, color: '#111827', margin: '0 0 0.5rem 0' }}>
                  รายการ ({lineCount}/{MAX_LINES})
                </h2>
                {lines.map((line, index) => (
                  <div
                    key={line.key}
                    data-testid={`material-receipt-line-${index}`}
                    style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end', padding: '0.5rem 0', borderBottom: '1px solid #e5e7eb', ...(line.voided ? { textDecoration: 'line-through', color: '#6b7280' } : {}) }}
                  >
                    <div style={{ flex: '1 1 12rem', fontSize: '0.875rem', color: '#111827', alignSelf: 'center' }}>
                      {correcting && `${positions[index] + 1}. `}
                      {line.name}
                      {!line.is_active && ` (${INACTIVE_LABEL})`}
                      {correcting && !line.voided && (
                        <div style={{ textDecoration: 'none' }}>
                          {factorLine(line) !== null && (
                            <span data-testid={`material-receipt-line-${index}-factor`} style={{ fontSize: '0.8125rem', color: '#4b5563' }}>
                              {CONVERSION_FACTOR_LABEL} {factorLine(line)}
                            </span>
                          )}{' '}
                          <button
                            type="button"
                            id={`material-receipt-line-${index}-change-material`}
                            onClick={() => setReplacing(replacing === index ? null : index)}
                            style={{ padding: '0 0.25rem', background: 'none', border: 'none', color: '#2563eb', textDecoration: 'underline', fontSize: '0.8125rem' }}
                          >
                            {replacing === index ? 'ไม่เปลี่ยน' : `เปลี่ยน${STOCK_MATERIAL_LABEL}`}
                          </button>
                          {keepsPair(line) && (
                            <label htmlFor={`material-receipt-line-${index}-recalculate`} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.8125rem', color: '#374151' }}>
                              <input id={`material-receipt-line-${index}-recalculate`} type="checkbox" checked={line.recalculate} onChange={(e) => changeLine(index, { recalculate: e.target.checked })} />
                              {RECALCULATE_LABEL}
                            </label>
                          )}
                        </div>
                      )}
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
                    {/* A recorded line is voided (ยกเลิกรายการ), never removed, in a Receipt Correction (#237). */}
                    {correcting && line.line_id !== null ? (
                      <button
                        type="button"
                        id={`material-receipt-line-${index}-void`}
                        onClick={() => changeLine(index, { voided: !line.voided })}
                        style={{ padding: '0.5rem 0.75rem', backgroundColor: line.voided ? '#f3f4f6' : '#fee2e2', color: line.voided ? '#374151' : '#991b1b', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.875rem' }}
                      >
                        {line.voided ? 'ไม่ยกเลิก' : VOID_LINE_LABEL}
                      </button>
                    ) : (
                      <button
                        type="button"
                        id={`material-receipt-line-${index}-remove`}
                        onClick={() => {
                          setReplacing(null);
                          setLines((current) => current.filter((_, at) => at !== index));
                        }}
                        style={{ padding: '0.5rem 0.75rem', backgroundColor: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.875rem' }}
                      >
                        นำออก
                      </button>
                    )}
                  </div>
                ))}
                {voidedBefore.map((line) => (
                  <div
                    key={line.id}
                    data-testid={`material-receipt-voided-line-${line.position}`}
                    style={{ padding: '0.5rem 0', borderBottom: '1px solid #e5e7eb', fontSize: '0.875rem', color: '#6b7280', textDecoration: 'line-through' }}
                  >
                    {/* A Received line always has its quantity and Unit (T3's confirm). */}
                    {line.position + 1}. {line.stock_material.name} {line.quantity} {line.unit!.name} ({VOIDED_LINE_LABEL})
                  </div>
                ))}
                {lines.length > 0 && (
                  <p style={{ fontSize: '0.875rem', color: '#374151', margin: '0.5rem 0 0 0' }}>
                    {AMOUNT_LABEL}รวม <strong data-testid="material-receipt-total-amount">{total === null ? '-' : formatAmount(total)}</strong> ({AMOUNT_FOR_REFERENCE_LABEL})
                  </p>
                )}

                {(lineCount < MAX_LINES || replacing !== null) && (
                  <div style={{ marginTop: '0.75rem', padding: '0.75rem', backgroundColor: '#f9fafb', borderRadius: '6px' }}>
                    <label htmlFor="material-receipt-stock-material-search" style={fieldLabelStyle}>
                      {replacing === null ? `เพิ่ม${STOCK_MATERIAL_LABEL}` : `เปลี่ยน${STOCK_MATERIAL_LABEL}ของรายการที่ ${positions[replacing] + 1}`}
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
                              {replacing === null ? 'เพิ่ม' : 'เลือก'}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {correcting && (
                  <div style={{ marginTop: '1rem' }}>
                    <label htmlFor="material-receipt-correction-reason" style={fieldLabelStyle}>
                      เหตุผลที่แก้ไข
                    </label>
                    <textarea id="material-receipt-correction-reason" value={reason} maxLength={2000} rows={3} onChange={(e) => setReason(e.target.value)} style={fieldInputStyle} />
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
 * F010-T6 (#237): with `correcting`, the Receipt Correction ("แก้ไขรายการที่บันทึกผิด") of a Received one, read back
 * whole: each line may change its Stock Material, Unit, quantity, ราคาต่อหน่วย or note, be voided (ยกเลิกรายการ) or
 * recalculated (คำนวณใหม่ด้วยอัตราแปลงปัจจุบัน), each showing the Conversion Factor it will be recorded at; lines may
 * be added; a reason is required; and a refusal names every failing rule (#231 Q18, Q25, Q29, P5).
 */
export const MaterialReceiptForm: React.FC<{ correcting?: boolean }> = ({ correcting = false }) => {
  const { id = null } = useParams();
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <MaterialReceiptFormContent id={id} correcting={correcting} />
    </QueryClientProvider>
  );
};
