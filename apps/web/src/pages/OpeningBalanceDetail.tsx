import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { thaiDate } from '../components/assignmentFacts';
import { LoanSaveForm } from '../components/LoanSaveForm';
import { useCsrfToken } from '../components/materialQueries';
import { BASE_UNIT_LABEL, CONVERSION_FACTOR_LABEL, INACTIVE_LABEL, STOCK_MATERIAL_LABEL, UNIT_LABEL } from '../components/materialFacts';
import { RECEIPT_CORRECTION_LABEL, receiptNumberLine, VOID_LINE_LABEL, VOIDED_LINE_LABEL } from '../components/materialReceiptFacts';
import { fieldInputStyle, fieldLabelStyle } from '../components/ReferenceContextFields';
import {
  AS_OF_DATE_LABEL,
  CONFIRM_OPENING_BALANCE_LABEL,
  EDIT_DRAFT_LABEL,
  OPENING_BALANCE_HISTORY_KIND_LABELS,
  OPENING_BALANCE_LABEL,
  OPENING_BALANCE_SOURCE_LABEL,
  OPENING_BALANCE_STATE_LABELS,
  REMOVE_DRAFT_LABEL,
  STOCK_MOVEMENT_LABEL,
  openingBalanceNumberLine,
  type BalanceCorrectionChange,
  type BalanceCorrectionFacts,
  type ConfirmProblem,
  type OpeningBalanceDetail as BalanceDetail,
} from '../components/openingBalanceFacts';

const THAI_DATE_TIME = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

const LOAD_ERRORS: Record<number, string> = {
  403: `คุณไม่มีสิทธิ์เข้าถึง${OPENING_BALANCE_LABEL} (403 Forbidden)`,
  404: `ไม่พบ${OPENING_BALANCE_LABEL}ที่ระบุ (404 Not Found)`,
  400: `ไม่พบ${OPENING_BALANCE_LABEL}ที่ระบุ`,
};

const cellStyle: React.CSSProperties = { padding: '0.5rem 0.75rem', color: '#111827', verticalAlign: 'top' };
const headStyle: React.CSSProperties = { padding: '0.5rem 0.75rem', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' };
const actionStyle: React.CSSProperties = { padding: '0.5rem 1.25rem', borderRadius: '6px', fontSize: '0.875rem', fontWeight: 500, textDecoration: 'none', border: 'none' };

type Action = 'confirm' | 'remove';

// F010-T7 (#238): the name of each field a correction records a change of.
const CORRECTION_FIELD_LABELS: Record<string, string> = {
  as_of_date: AS_OF_DATE_LABEL,
  source: OPENING_BALANCE_SOURCE_LABEL,
  note: 'หมายเหตุ',
  stock_material: STOCK_MATERIAL_LABEL,
  unit: UNIT_LABEL,
  quantity: 'จำนวน',
  conversion_factor: CONVERSION_FACTOR_LABEL,
  base_quantity: `จำนวน (${BASE_UNIT_LABEL})`,
};

// One changed value as "<field> <before> → <after>", a name as it was then, "-" for none.
const changeLine = ({ field, before, after }: BalanceCorrectionChange): string => {
  const shown = (value: BalanceCorrectionChange['before']): string => (value === null ? '-' : typeof value === 'object' ? value.name : field === 'as_of_date' ? thaiDate(value) : value);
  return `${CORRECTION_FIELD_LABELS[field]} ${shown(before)} → ${shown(after)}`;
};

// What a CORRECTED or VOIDED history entry changed: each header field, then each line changed, added or voided, by
// its number.
const correctionLines = (facts: BalanceCorrectionFacts): string[] => [
  ...(facts.changes ?? []).map(changeLine),
  ...facts.lines.map((entry) =>
    entry.change === 'CHANGED'
      ? `รายการที่ ${entry.position + 1}: ${entry.changes.map(changeLine).join(', ')}`
      : `${entry.change === 'ADDED' ? 'เพิ่มรายการ' : VOID_LINE_LABEL}ที่ ${entry.position + 1}: ${entry.line.stock_material.name} ${entry.line.quantity} ${entry.line.unit.name}`
  ),
];

// A refusal names a line by its place, `lines[<i>]`: the page names it by its number in the table (ลำดับ).
const problemLine = (problem: ConfirmProblem): string => {
  const line = /^lines\[(\d+)\]/.exec(problem.field);
  return line === null ? problem.message : `รายการที่ ${Number(line[1]) + 1}: ${problem.message}`;
};

const OpeningBalanceDetailContent: React.FC<{ id: string }> = ({ id }) => {
  const navigate = useNavigate();
  const [action, setAction] = useState<Action | null>(null);
  // F010-T7 (#238): whether the void (ยกเลิกรายการ) is open, and the reason typed in it.
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');

  const balance = useQuery<BalanceDetail, Error & { status?: number }>({
    queryKey: ['opening-balance', id],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/opening-balances/${encodeURIComponent(id)}`, { credentials: 'include', signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
  });

  const isSignedOut = balance.error?.status === 401;
  useEffect(() => {
    if (isSignedOut) {
      navigate('/login', { replace: true });
    }
  }, [isSignedOut, navigate]);

  // A failed read hides what an earlier one showed: a lost grant fails closed.
  const detail = balance.isError ? undefined : balance.data;
  const isForbidden = balance.error?.status === 403 || balance.error?.status === 404 || balance.error?.status === 400;
  const mayManage = detail?.can_manage === true && detail.state === 'DRAFT';
  // F010-T7 (#238): a confirmed one is corrected or voided, by whoever may record Opening Balances.
  const mayCorrect = detail?.can_manage === true && detail.state === 'CONFIRMED';
  // Each action waits for the token: a request sent without it is refused as if the grant were gone (#135).
  const session = useCsrfToken(mayManage || mayCorrect);
  const csrfToken = session.data ?? null;
  const offersActions = mayManage && csrfToken !== null && action === null;
  // The open form closes once the Opening Balance is no longer a Draft.
  const acting = mayManage ? action : null;
  // F010-T7 (#238): the void closes once the Opening Balance is no longer confirmed.
  const voidOpen = mayCorrect && voiding;

  return (
    <main style={{ minHeight: '100vh', backgroundColor: '#f3f4f6', padding: '1rem', fontFamily: 'system-ui, -apple-system, sans-serif', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: '1000px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1)', padding: '1.25rem', boxSizing: 'border-box' }}>
        <Link to="/opening-balances" id="back-opening-balance-list-link" style={{ color: '#4b5563', textDecoration: 'none', fontSize: '0.875rem', fontWeight: 500 }}>
          ← กลับสู่{OPENING_BALANCE_LABEL}
        </Link>

        {balance.isError && !isSignedOut && (
          <div role="alert" id="opening-balance-error" style={{ padding: '0.75rem 1rem', margin: '1rem 0', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            {LOAD_ERRORS[Number(balance.error.status)] ?? `เกิดข้อผิดพลาดในการโหลด${OPENING_BALANCE_LABEL}`}{' '}
            {!isForbidden && (
              <button type="button" id="opening-balance-retry" onClick={() => balance.refetch()}>
                ลองใหม่
              </button>
            )}
          </div>
        )}

        {balance.isPending && (
          <div role="status" aria-busy="true" style={{ padding: '2rem', textAlign: 'center', color: '#6b7280', fontSize: '0.875rem' }}>
            กำลังโหลด{OPENING_BALANCE_LABEL}...
          </div>
        )}

        {detail && (
          <>
            {/* Named by its number once confirmed, or as a Draft (P10). */}
            <h1 data-testid="opening-balance-heading" style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: '1rem 0 0.5rem 0' }}>
              {OPENING_BALANCE_LABEL} {detail.opening_balance_number === null ? OPENING_BALANCE_STATE_LABELS.DRAFT : openingBalanceNumberLine(detail.opening_balance_number)}
            </h1>
            <p style={{ margin: '0 0 1.25rem 0', fontSize: '0.9375rem', color: '#374151' }}>
              <span
                data-testid="opening-balance-state"
                style={{ padding: '0.125rem 0.5rem', backgroundColor: detail.state === 'DRAFT' ? '#fef3c7' : '#dcfce7', color: detail.state === 'DRAFT' ? '#92400e' : '#166534', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 600 }}
              >
                {OPENING_BALANCE_STATE_LABELS[detail.state]}
              </span>
            </p>

            <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.5rem 1.5rem', fontSize: '0.875rem', margin: '0 0 1.5rem 0' }}>
              <dt style={{ fontWeight: 500, color: '#4b5563' }}>{AS_OF_DATE_LABEL}</dt>
              <dd data-testid="opening-balance-as-of-date" style={{ margin: 0 }}>{detail.as_of_date === null ? '-' : thaiDate(detail.as_of_date)}</dd>
              <dt style={{ fontWeight: 500, color: '#4b5563' }}>{OPENING_BALANCE_SOURCE_LABEL}</dt>
              <dd data-testid="opening-balance-source" style={{ margin: 0, whiteSpace: 'pre-line' }}>{detail.source ?? '-'}</dd>
              <dt style={{ fontWeight: 500, color: '#4b5563' }}>หมายเหตุ</dt>
              <dd style={{ margin: 0, whiteSpace: 'pre-line' }}>{detail.note ?? '-'}</dd>
              <dt style={{ fontWeight: 500, color: '#4b5563' }}>บันทึกโดย</dt>
              <dd style={{ margin: 0 }}>
                {detail.created_by_username ?? '-'} เมื่อ {THAI_DATE_TIME.format(new Date(detail.created_at))}
              </dd>
              {detail.confirmed_at !== null && (
                <>
                  <dt style={{ fontWeight: 500, color: '#4b5563' }}>ยืนยันโดย</dt>
                  <dd data-testid="opening-balance-confirmed" style={{ margin: 0 }}>
                    {detail.confirmed_by_username ?? '-'} เมื่อ {THAI_DATE_TIME.format(new Date(detail.confirmed_at))}
                  </dd>
                </>
              )}
            </dl>

            {offersActions && (
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
                <Link to={`/opening-balances/${id}/edit`} id="opening-balance-edit-action" style={{ ...actionStyle, backgroundColor: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db' }}>
                  {EDIT_DRAFT_LABEL}
                </Link>
                <button type="button" id="opening-balance-confirm-action" onClick={() => setAction('confirm')} style={{ ...actionStyle, backgroundColor: '#2563eb', color: '#ffffff' }}>
                  {CONFIRM_OPENING_BALANCE_LABEL}
                </button>
                <button type="button" id="opening-balance-remove-action" onClick={() => setAction('remove')} style={{ ...actionStyle, backgroundColor: '#fee2e2', color: '#991b1b' }}>
                  {REMOVE_DRAFT_LABEL}
                </button>
              </div>
            )}

            {mayCorrect && (
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
                <Link to={`/opening-balances/${id}/correct`} id="opening-balance-correct-action" style={{ ...actionStyle, backgroundColor: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db' }}>
                  {RECEIPT_CORRECTION_LABEL}
                </Link>
                {!voiding && (
                  <button
                    type="button"
                    id="opening-balance-void-action"
                    onClick={() => {
                      setReason('');
                      setVoiding(true);
                    }}
                    style={{ ...actionStyle, backgroundColor: '#fee2e2', color: '#991b1b' }}
                  >
                    {VOID_LINE_LABEL}
                  </button>
                )}
              </div>
            )}

            {/* F010-T7 (#238): the void of the whole Opening Balance, with a reason (story 43). */}
            {voidOpen && csrfToken !== null && (
              <LoanSaveForm
                idPrefix="opening-balance-void"
                heading={VOID_LINE_LABEL}
                saveUrl={`/opening-balances/${encodeURIComponent(id)}/void`}
                csrfToken={csrfToken}
                requestError={() => (reason.trim() === '' ? 'กรุณากรอกเหตุผลที่ยกเลิก' : null)}
                requestBody={() => ({ expected_version: detail.version, reason })}
                refusedList={() => null}
                forbiddenMessage={`คุณไม่มีสิทธิ์บันทึก${OPENING_BALANCE_LABEL}`}
                refusedMessage={`ไม่สามารถ${VOID_LINE_LABEL}ได้`}
                staleMessage={`มีผู้แก้ไข${OPENING_BALANCE_LABEL}นี้ไปแล้ว กรุณาโหลดใหม่`}
                submitLabel={VOID_LINE_LABEL}
                onRefresh={async () => (await balance.refetch()).isSuccess}
                onSaved={async () => {
                  setVoiding(false);
                  await balance.refetch();
                }}
                onCancel={() => setVoiding(false)}
                onPermissionRevoked={() => void balance.refetch()}
              >
                {(isLocked) => (
                  <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0', minWidth: 0 }}>
                    <p data-testid="opening-balance-void-notice" style={{ fontSize: '0.875rem', color: '#4b5563', margin: '0 0 0.75rem 0' }}>
                      ระบบจะบันทึกกลับรายการของทุกรายการ โดยไม่ลบรายการเดิม {OPENING_BALANCE_LABEL}นี้จะแสดงเป็น{VOIDED_LINE_LABEL} และแก้ไขอีกไม่ได้
                    </p>
                    <label htmlFor="opening-balance-void-reason" style={fieldLabelStyle}>
                      เหตุผลที่ยกเลิก
                    </label>
                    <textarea id="opening-balance-void-reason" value={reason} maxLength={2000} rows={3} onChange={(e) => setReason(e.target.value)} style={fieldInputStyle} />
                  </fieldset>
                )}
              </LoanSaveForm>
            )}

            {acting !== null && csrfToken !== null && (
              <LoanSaveForm
                idPrefix={`opening-balance-${acting}`}
                heading={acting === 'confirm' ? CONFIRM_OPENING_BALANCE_LABEL : REMOVE_DRAFT_LABEL}
                saveUrl={`/opening-balances/${encodeURIComponent(id)}/${acting}`}
                csrfToken={csrfToken}
                requestError={() => null}
                requestBody={() => ({ expected_version: detail.version })}
                refusedList={(body) =>
                  body?.code === 'NOT_CONFIRMABLE' && Array.isArray(body.problems) ? (
                    <>
                      <p style={{ margin: '0 0 0.5rem 0' }}>ยังยืนยันไม่ได้ กรุณาแก้ไขร่างตามรายการนี้</p>
                      <ul data-testid="opening-balance-confirm-problems" style={{ margin: 0, paddingLeft: '1.25rem' }}>
                        {(body.problems as ConfirmProblem[]).map((problem, index) => (
                          <li key={index}>
                            {problemLine(problem)}
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
                refusedMessage={acting === 'confirm' ? `ไม่สามารถ${CONFIRM_OPENING_BALANCE_LABEL}ได้` : `ไม่สามารถ${REMOVE_DRAFT_LABEL}ได้`}
                staleMessage="มีผู้แก้ไขร่างนี้ไปแล้ว กรุณาโหลดใหม่"
                submitLabel={acting === 'confirm' ? CONFIRM_OPENING_BALANCE_LABEL : REMOVE_DRAFT_LABEL}
                onRefresh={async () => (await balance.refetch()).isSuccess}
                onSaved={async () => {
                  setAction(null);
                  if (acting === 'remove') {
                    navigate('/opening-balances');
                    return;
                  }
                  await balance.refetch();
                }}
                onCancel={() => setAction(null)}
                onPermissionRevoked={() => void balance.refetch()}
              >
                {() => (
                  <p data-testid={`opening-balance-${acting}-notice`} style={{ fontSize: '0.875rem', color: '#4b5563', margin: '0 0 1rem 0' }}>
                    {acting === 'confirm'
                      ? `เมื่อยืนยันแล้ว ระบบจะออกเลขที่และบันทึก${STOCK_MOVEMENT_LABEL}ของทุกรายการ แก้ไขร่างนี้ไม่ได้อีก`
                      : 'ร่างนี้จะถูกลบออกจากระบบและกู้คืนไม่ได้'}
                  </p>
                )}
              </LoanSaveForm>
            )}

            <h2 style={{ fontSize: '1.125rem', fontWeight: 600, color: '#111827', margin: '0 0 0.75rem 0' }}>รายการ ({detail.lines.length})</h2>
            {detail.lines.length === 0 ? (
              <p id="opening-balance-lines-empty" style={{ fontSize: '0.875rem', color: '#6b7280' }}>
                ยังไม่มีรายการ
              </p>
            ) : (
              <div style={{ overflowX: 'auto', marginBottom: '1.5rem' }}>
                <table id="opening-balance-lines-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.875rem' }}>
                  <thead>
                    <tr style={{ backgroundColor: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                      <th style={headStyle}>ลำดับ</th>
                      <th style={headStyle}>วัสดุ</th>
                      <th style={headStyle}>จำนวน</th>
                      <th style={headStyle}>{UNIT_LABEL}</th>
                      <th style={headStyle}>{STOCK_MOVEMENT_LABEL}</th>
                      <th style={headStyle}>หมายเหตุ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((line) => {
                      const movement = line.stock_movements.find((recorded) => recorded.id === line.stock_movement_id);
                      // F010-T7 (#238): a voided line stays shown, struck through, as ยกเลิกแล้ว, as a Material Receipt's.
                      const struck: React.CSSProperties = line.is_voided ? { textDecoration: 'line-through', color: '#6b7280' } : {};
                      return (
                        <tr key={line.id} data-testid={`opening-balance-line-${line.position}`} style={{ borderBottom: '1px solid #e5e7eb', ...struck }}>
                          <td style={cellStyle}>{line.position + 1}</td>
                          <td style={cellStyle}>
                            <Link to={`/stock-materials/${line.stock_material.id}`} style={{ color: '#2563eb', textDecoration: 'underline' }}>
                              {line.stock_material.name}
                            </Link>
                            {!line.stock_material.is_active && ` (${INACTIVE_LABEL})`}
                            {line.is_voided && (
                              <span
                                data-testid={`opening-balance-line-${line.position}-voided`}
                                style={{ marginLeft: '0.5rem', padding: '0.125rem 0.5rem', backgroundColor: '#f3f4f6', color: '#4b5563', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 600, display: 'inline-block', textDecoration: 'none' }}
                              >
                                {VOIDED_LINE_LABEL}
                              </span>
                            )}
                          </td>
                          <td style={cellStyle}>{line.quantity ?? '-'}</td>
                          <td style={cellStyle}>{line.unit?.name ?? '-'}</td>
                          {/* In the Base Unit, with the conversion it was recorded with (#231 Numbers). */}
                          <td style={cellStyle}>
                            {movement
                              ? `+${movement.base_quantity} ${movement.base_unit.name} (${movement.original_quantity} ${movement.original_unit.name} × ${movement.conversion_factor}) ณ ${thaiDate(movement.effective_date)}`
                              : '-'}
                          </td>
                          <td style={{ ...cellStyle, whiteSpace: 'pre-line' }}>{line.note ?? '-'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {detail.history.length > 0 && (
              <section aria-label="ประวัติ">
                <h2 style={{ fontSize: '1.125rem', fontWeight: 600, color: '#111827', margin: '0 0 0.75rem 0' }}>ประวัติ</h2>
                <ol id="opening-balance-history" style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.875rem', color: '#374151' }}>
                  {detail.history.map((entry) => (
                    <li key={entry.version} data-testid={`opening-balance-history-${entry.version}`} style={{ marginBottom: '0.5rem' }}>
                      {OPENING_BALANCE_HISTORY_KIND_LABELS[entry.kind]} โดย {entry.recorded_by_username ?? '-'} เมื่อ {THAI_DATE_TIME.format(new Date(entry.recorded_at))}
                      {entry.reason !== null && <div style={{ color: '#4b5563', whiteSpace: 'pre-line' }}>เหตุผล: {entry.reason}</div>}
                      {/* F010-T7 (#238, story 35): each value a correction changed, as it was and as it became, and each line
                          the void of the whole Opening Balance voided. */}
                      {(entry.kind === 'CORRECTED' || entry.kind === 'VOIDED') && (
                        <ul data-testid={`opening-balance-history-${entry.version}-changes`} style={{ margin: '0.25rem 0 0 0', paddingLeft: '1.25rem', color: '#4b5563' }}>
                          {correctionLines(entry.facts as unknown as BalanceCorrectionFacts).map((change, index) => (
                            <li key={index}>{change}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
};

/**
 * F010-T2 (#233): an Opening Balance's page: its number and state, ยอด ณ วันที่, ที่มาของยอด and note, each line with its
 * Stock Material, quantity, Unit and the Stock Movement it made, and its history; on a Draft, "แก้ไขร่าง",
 * "ยืนยันยอดตั้งต้น" with every failing rule listed, and "ลบร่าง" for a Supply Officer (#231 Q13, Q24, Q25).
 */
export const OpeningBalanceDetail: React.FC = () => {
  const { id = '' } = useParams();
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <OpeningBalanceDetailContent id={id} />
    </QueryClientProvider>
  );
};
