import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { LoanSaveForm } from '../components/LoanSaveForm';
import { useCsrfToken } from '../components/materialQueries';
import { CONVERSION_FACTOR_LABEL, conversionLine, INACTIVE_LABEL, STOCK_MATERIAL_LABEL, UNIT_LABEL, type StockMaterialDetail, type StockMaterialList } from '../components/materialFacts';
import { RECALCULATE_LABEL, RECEIPT_CORRECTION_LABEL, receiptNumberLine, VOID_LINE_LABEL, VOIDED_LINE_LABEL } from '../components/materialReceiptFacts';
import { fieldInputStyle, fieldLabelStyle } from '../components/ReferenceContextFields';
import {
  ADD_OPENING_BALANCE_LABEL,
  AS_OF_DATE_LABEL,
  EDIT_DRAFT_LABEL,
  OPENING_BALANCE_LABEL,
  OPENING_BALANCE_SOURCE_LABEL,
  SAVE_DRAFT_LABEL,
  openingBalanceNumberLine,
  type ConfirmProblem,
  type OpeningBalanceDetail,
  type OpeningBalanceLine,
  type OpeningBalanceList,
} from '../components/openingBalanceFacts';

// #231 Q25, P7: at most 50 lines, voided ones included (F010-T7); the source 500 characters, the note 2000 and a line's
// note 500.
const MAX_LINES = 50;
const CHOICES_PAGE_SIZE = 10;

// A line as the form holds it: its Stock Material with the Units it may be counted in, and what is typed.
interface DraftLine {
  // The line's own key: its id, or a new one for a line added.
  key: string;
  stock_material_id: string;
  name: string;
  is_active: boolean;
  // The Stock Material's active Units (#231 Q11), and the chosen one even when no longer active.
  units: { unit_id: string; name: string }[];
  // Each of the Stock Material's Units by id, with its name and today's Conversion Factor, and its Base Unit's name.
  catalog: Record<string, { name: string; conversion_factor: string | null }>;
  base_name: string;
  unit_id: string;
  quantity: string;
  note: string;
  // F010-T7 (#238), in a correction: the line it is (null for a line added), its place, what it recorded, whether this
  // correction voids it, and whether it takes today's Conversion Factor (#231 Q18, Q29).
  line_id: string | null;
  position: number | null;
  recorded: { stock_material_id: string; unit_id: string; conversion_factor: string } | null;
  voided: boolean;
  recalculate: boolean;
}

// A line a correction keeps with its Stock Material and Unit as recorded, so its Conversion Snapshot holds unless it is
// recalculated (#237 start decision 4, which the Opening Balance follows).
const keepsPair = (line: DraftLine): boolean => line.recorded !== null && line.recorded.stock_material_id === line.stock_material_id && line.recorded.unit_id === line.unit_id;

// The Conversion Factor the line will be recorded at, as "1 <Unit> = <factor> <Base Unit>": its snapshot while it
// keeps its pair, otherwise today's factor of its Unit (#231 Q29). Null with no Unit chosen. A correction offers an
// active Unit or the line's own, and either has a factor (see MaterialReceiptForm's factorLine).
const factorLine = (line: DraftLine): string | null => {
  const unit = line.catalog[line.unit_id];
  if (unit === undefined) {
    return null;
  }
  const factor = keepsPair(line) && !line.recalculate ? line.recorded!.conversion_factor : unit.conversion_factor!;
  return conversionLine(unit.name, factor, line.base_name);
};

// A refusal names a line by its place in the request, `lines[<i>]`: the form names it by its number (ลำดับ).
const problemLine = (problem: ConfirmProblem, positions: number[]): string => {
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

// A recorded line's pair and Conversion Snapshot: a confirmed one's, which a correction reads, from its Stock Movement
// in effect; a Draft's line has none.
const recordedOf = (line: OpeningBalanceLine): DraftLine['recorded'] => {
  const movement = line.stock_movements.find((recorded) => recorded.id === line.stock_movement_id);
  return movement === undefined ? null : { stock_material_id: line.stock_material.id, unit_id: movement.original_unit.unit_id, conversion_factor: movement.conversion_factor };
};

const OpeningBalanceFormContent: React.FC<{ id: string | null; correcting: boolean }> = ({ id, correcting }) => {
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
  // F010-T7 (#238), in a correction: its reason, the lines voided before it, shown and never sent, the line whose Stock
  // Material a search replaces, and the place of each line sent, which a refusal names.
  const [reason, setReason] = useState('');
  const [voidedBefore, setVoidedBefore] = useState<OpeningBalanceLine[]>([]);
  const [replacing, setReplacing] = useState<number | null>(null);
  const sentPositions = useRef<number[]>([]);

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
    setReplacing(null);
    setVoidedBefore(detail.lines.filter((line) => line.is_voided));
    void Promise.all(
      detail.lines.filter((line) => !line.is_voided).map(async (line) => ({
        key: line.id,
        stock_material_id: line.stock_material.id,
        ...(await unitsOf(line.stock_material.id, line.unit?.unit_id ?? null)),
        unit_id: line.unit?.unit_id ?? '',
        quantity: line.quantity ?? '',
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

  // A Draft is edited; a confirmed Opening Balance only corrected (F010-T7, #238).
  const mayManage = id === null ? grant.data?.can_manage === true : existing.data?.can_manage === true && existing.data.state === (correcting ? 'CONFIRMED' : 'DRAFT');
  const session = useCsrfToken(mayManage);
  const csrfToken = session.data ?? null;
  const ready = mayManage && csrfToken !== null && (id === null || version !== null);

  // One line per Stock Material (#231 Q9): in a correction, a line voided before it or by it still holds its own (start
  // decision 3), so only the line `replacing` gives its Stock Material up.
  const holds = (materialId: string): boolean =>
    lines.some((line, at) => at !== replacing && line.stock_material_id === materialId) || voidedBefore.some((line) => line.stock_material.id === materialId);

  // A new line takes the Stock Material's first Unit, its Base Unit, never Inactive (stock_material_units_base_unit); in
  // a correction, a search may instead replace the Stock Material of the line `replacing`, which then takes that Unit
  // at today's Conversion Factor. A Stock Material a line holds is offered with its button disabled.
  const addLine = async (materialId: string) => {
    setAddError(null);
    try {
      const material = await unitsOf(materialId, null);
      const unit_id = material.units[0].unit_id;
      setLines((current) => {
        if (replacing !== null) {
          return current.map((line, at) => (at === replacing ? { ...line, stock_material_id: materialId, ...material, unit_id, recalculate: false } : line));
        }
        const added: DraftLine = { key: crypto.randomUUID(), stock_material_id: materialId, ...material, unit_id, quantity: '', note: '', line_id: null, position: null, recorded: null, voided: false, recalculate: false };
        return [...current, added];
      });
      setReplacing(null);
    } catch {
      setAddError('ไม่สามารถโหลดหน่วยนับของวัสดุได้ กรุณาลองใหม่');
    }
  };
  const changeLine = (index: number, change: Partial<DraftLine>) => setLines((current) => current.map((line, at) => (at === index ? { ...line, ...change } : line)));

  // F010-T7 (#238): a line added in a correction takes the next place after every line, voided ones included: the
  // places run from 0 with no gap.
  const nextPosition = voidedBefore.length + lines.filter((line) => line.line_id !== null).length;
  let added = 0;
  const positions = lines.map((line) => line.position ?? nextPosition + added++);
  const lineCount = lines.length + voidedBefore.length;

  const heading = id === null ? ADD_OPENING_BALANCE_LABEL : correcting ? RECEIPT_CORRECTION_LABEL : EDIT_DRAFT_LABEL;
  // The whole Opening Balance as it should be (#231 P5): each line kept, by its id, or added, the lines it voids, and
  // the reason.
  const correction = () => {
    const kept = lines.filter((line) => !line.voided);
    sentPositions.current = kept.map((line) => positions[lines.indexOf(line)]);
    return {
      expected_version: version,
      as_of_date: asOfDate,
      // The API trims free text and saves a blank one as none.
      source,
      note,
      // A line added has no line_id (null).
      lines: kept.map((line) => ({
        line_id: line.line_id,
        stock_material_id: line.stock_material_id,
        unit_id: line.unit_id,
        quantity: line.quantity.trim(),
        note: line.note,
        recalculate: line.recalculate,
      })),
      voided_line_ids: lines.filter((line) => line.voided).map((line) => line.line_id),
      reason,
    };
  };
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
            {id === null
              ? `คุณไม่มีสิทธิ์บันทึก${OPENING_BALANCE_LABEL}`
              : correcting
                ? `${RECEIPT_CORRECTION_LABEL}ได้เฉพาะ${OPENING_BALANCE_LABEL}ที่ยืนยันแล้ว โดยผู้มีสิทธิ์บันทึก${OPENING_BALANCE_LABEL}`
                : `แก้ไขได้เฉพาะร่างโดยผู้มีสิทธิ์บันทึก${OPENING_BALANCE_LABEL}`}
          </div>
        )}

        {ready && (
          <LoanSaveForm
            idPrefix={correcting ? 'opening-balance-correction' : 'opening-balance-draft'}
            heading={heading}
            saveUrl={id === null ? '/opening-balances' : `/opening-balances/${encodeURIComponent(id)}${correcting ? '/correct' : ''}`}
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
            requestBody={() =>
              correcting
                ? correction()
                : {
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
                  }
            }
            // A correction refused names every failing rule, a line's by its number (#231 Q25); a Draft's save is never
            // refused with problems.
            refusedList={(body) =>
              Array.isArray(body?.problems) ? (
                <>
                  <p style={{ margin: '0 0 0.5rem 0' }}>ยังบันทึกการแก้ไขไม่ได้ กรุณาแก้ตามรายการนี้</p>
                  <ul data-testid="opening-balance-correction-problems" style={{ margin: 0, paddingLeft: '1.25rem' }}>
                    {(body!.problems as ConfirmProblem[]).map((problem, index) => (
                      <li key={index}>
                        {problemLine(problem, sentPositions.current)}
                        {problem.in_effect_opening_balance && (
                          <>
                            {' '}
                            (<Link to={`/opening-balances/${problem.in_effect_opening_balance.opening_balance_id}`}>{openingBalanceNumberLine(problem.in_effect_opening_balance.opening_balance_number)}</Link>)
                          </>
                        )}
                        {problem.in_effect_material_receipt && (
                          <>
                            {' '}
                            (<Link to={`/material-receipts/${problem.in_effect_material_receipt.material_receipt_id}`}>{receiptNumberLine(problem.in_effect_material_receipt.receipt_number)}</Link>)
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null
            }
            forbiddenMessage={`คุณไม่มีสิทธิ์บันทึก${OPENING_BALANCE_LABEL}`}
            refusedMessage={`ไม่สามารถบันทึก${OPENING_BALANCE_LABEL}ได้`}
            staleMessage={correcting ? `มีผู้แก้ไข${OPENING_BALANCE_LABEL}นี้ไปแล้ว กรุณาโหลดใหม่` : 'มีผู้แก้ไขร่างนี้ไปแล้ว กรุณาโหลดใหม่'}
            submitLabel={correcting ? 'บันทึกการแก้ไข' : SAVE_DRAFT_LABEL}
            onRefresh={
              id === null
                ? undefined
                : // The form reads the Opening Balance again once the new read is in: cleared first, it would read back the
                  // one it holds; a read that fails leaves the form as it is (#237 retro).
                  async () => {
                    const fresh = await existing.refetch();
                    if (fresh.isSuccess) {
                      setVersion(null);
                    }
                    return fresh.isSuccess;
                  }
            }
            onSaved={async (body) => {
              navigate(`/opening-balances/${body.opening_balance_id}`);
            }}
            onCancel={() => navigate(id === null ? '/opening-balances' : `/opening-balances/${id}`)}
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

                <h2 style={{ fontSize: '1rem', fontWeight: 600, color: '#111827', margin: '0 0 0.5rem 0' }}>
                  รายการ ({lineCount}/{MAX_LINES})
                </h2>
                {lines.map((line, index) => (
                  <div
                    key={line.key}
                    data-testid={`opening-balance-line-${index}`}
                    style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end', padding: '0.5rem 0', borderBottom: '1px solid #e5e7eb', ...(line.voided ? { textDecoration: 'line-through', color: '#6b7280' } : {}) }}
                  >
                    <div style={{ flex: '1 1 14rem', fontSize: '0.875rem', color: '#111827', alignSelf: 'center' }}>
                      {correcting && `${positions[index] + 1}. `}
                      {line.name}
                      {!line.is_active && ` (${INACTIVE_LABEL})`}
                      {correcting && !line.voided && (
                        <div style={{ textDecoration: 'none' }}>
                          {factorLine(line) !== null && (
                            <span data-testid={`opening-balance-line-${index}-factor`} style={{ fontSize: '0.8125rem', color: '#4b5563' }}>
                              {CONVERSION_FACTOR_LABEL} {factorLine(line)}
                            </span>
                          )}{' '}
                          <button
                            type="button"
                            id={`opening-balance-line-${index}-change-material`}
                            onClick={() => setReplacing(replacing === index ? null : index)}
                            style={{ padding: '0 0.25rem', background: 'none', border: 'none', color: '#2563eb', textDecoration: 'underline', fontSize: '0.8125rem' }}
                          >
                            {replacing === index ? 'ไม่เปลี่ยน' : `เปลี่ยน${STOCK_MATERIAL_LABEL}`}
                          </button>
                          {keepsPair(line) && (
                            <label htmlFor={`opening-balance-line-${index}-recalculate`} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.8125rem', color: '#374151' }}>
                              <input id={`opening-balance-line-${index}-recalculate`} type="checkbox" checked={line.recalculate} onChange={(e) => changeLine(index, { recalculate: e.target.checked })} />
                              {RECALCULATE_LABEL}
                            </label>
                          )}
                        </div>
                      )}
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
                    {/* A recorded line is voided (ยกเลิกรายการ), never removed, in a correction (F010-T7, #238). */}
                    {correcting && line.line_id !== null ? (
                      <button
                        type="button"
                        id={`opening-balance-line-${index}-void`}
                        onClick={() => {
                          setReplacing(null);
                          changeLine(index, { voided: !line.voided });
                        }}
                        style={{ padding: '0.5rem 0.75rem', backgroundColor: line.voided ? '#f3f4f6' : '#fee2e2', color: line.voided ? '#374151' : '#991b1b', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.875rem' }}
                      >
                        {line.voided ? 'ไม่ยกเลิก' : VOID_LINE_LABEL}
                      </button>
                    ) : (
                      <button
                        type="button"
                        id={`opening-balance-line-${index}-remove`}
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
                    data-testid={`opening-balance-voided-line-${line.position}`}
                    style={{ padding: '0.5rem 0', borderBottom: '1px solid #e5e7eb', fontSize: '0.875rem', color: '#6b7280', textDecoration: 'line-through' }}
                  >
                    {/* A confirmed line always has its quantity and Unit (T2's confirm). */}
                    {line.position + 1}. {line.stock_material.name} {line.quantity} {line.unit!.name} ({VOIDED_LINE_LABEL})
                  </div>
                ))}

                {(lineCount < MAX_LINES || replacing !== null) && (
                  <div style={{ marginTop: '0.75rem', padding: '0.75rem', backgroundColor: '#f9fafb', borderRadius: '6px' }}>
                    <label htmlFor="opening-balance-stock-material-search" style={fieldLabelStyle}>
                      {replacing === null ? `เพิ่ม${STOCK_MATERIAL_LABEL}` : `เปลี่ยน${STOCK_MATERIAL_LABEL}ของรายการที่ ${positions[replacing] + 1}`}
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
                      <button
                        type="button"
                        id="opening-balance-stock-material-search-submit"
                        onClick={() => setSearch(searchInput)}
                        style={{ padding: '0.5rem 1rem', backgroundColor: '#4b5563', color: '#ffffff', border: 'none', borderRadius: '6px', fontSize: '0.875rem' }}
                      >
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
                              disabled={holds(material.id)}
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
                    <label htmlFor="opening-balance-correction-reason" style={fieldLabelStyle}>
                      เหตุผลที่แก้ไข
                    </label>
                    <textarea id="opening-balance-correction-reason" value={reason} maxLength={2000} rows={3} onChange={(e) => setReason(e.target.value)} style={fieldInputStyle} />
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
 *
 * F010-T7 (#238): with `correcting`, the correction ("แก้ไขรายการที่บันทึกผิด") of a confirmed one, read back whole, as a
 * Receipt Correction is (T6): each recorded line may change its quantity, Unit, Stock Material or note, or be
 * recalculated (คำนวณใหม่ด้วยอัตราแปลงปัจจุบัน), each showing the Conversion Factor it will be recorded at; lines may be
 * voided (ยกเลิกรายการ) or added; a reason is required; and a refusal names every failing rule (#231 Q18, Q25, Q29, P5).
 */
export const OpeningBalanceForm: React.FC<{ correcting?: boolean }> = ({ correcting = false }) => {
  const { id = null } = useParams();
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <OpeningBalanceFormContent id={id} correcting={correcting} />
    </QueryClientProvider>
  );
};
