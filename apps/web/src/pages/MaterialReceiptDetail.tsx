import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { thaiDate } from '../components/assignmentFacts';
import { LoanSaveForm } from '../components/LoanSaveForm';
import { useCsrfToken } from '../components/materialQueries';
import { INACTIVE_LABEL, MATERIAL_RECEIPT_LABEL, SOURCE_PARTY_LABEL, SOURCE_TYPE_LABEL, UNIT_LABEL } from '../components/materialFacts';
import {
  AMOUNT_FOR_REFERENCE_LABEL,
  AMOUNT_LABEL,
  CONFIRM_RECEIPT_LABEL,
  formatAmount,
  lineAmount,
  MATERIAL_RECEIPT_HISTORY_KIND_LABELS,
  MATERIAL_RECEIPT_STATE_LABELS,
  RECEIPT_REFERENCE_LABEL,
  RECEIVED_DATE_LABEL,
  receiptNumberLine,
  UNIT_PRICE_LABEL,
  type MaterialReceiptDetail as ReceiptDetail,
  type ReceiptConfirmProblem,
  type ReceiptListEntry,
} from '../components/materialReceiptFacts';
import { EDIT_DRAFT_LABEL, openingBalanceNumberLine, REMOVE_DRAFT_LABEL, STOCK_MOVEMENT_LABEL } from '../components/openingBalanceFacts';

const THAI_DATE_TIME = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

const LOAD_ERRORS: Record<number, string> = {
  403: `คุณไม่มีสิทธิ์เข้าถึง${MATERIAL_RECEIPT_LABEL} (403 Forbidden)`,
  404: `ไม่พบ${MATERIAL_RECEIPT_LABEL}ที่ระบุ (404 Not Found)`,
  400: `ไม่พบ${MATERIAL_RECEIPT_LABEL}ที่ระบุ`,
};

const cellStyle: React.CSSProperties = { padding: '0.5rem 0.75rem', color: '#111827', verticalAlign: 'top' };
const headStyle: React.CSSProperties = { padding: '0.5rem 0.75rem', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' };
const actionStyle: React.CSSProperties = { padding: '0.5rem 1.25rem', borderRadius: '6px', fontSize: '0.875rem', fontWeight: 500, textDecoration: 'none', border: 'none' };

type Action = 'confirm' | 'remove';

// A refusal names a line by its place, `lines[<i>]`: the page names it by its number in the table (ลำดับ).
const problemLine = (problem: ReceiptConfirmProblem): string => {
  const line = /^lines\[(\d+)\]/.exec(problem.field);
  return line === null ? problem.message : `รายการที่ ${Number(line[1]) + 1}: ${problem.message}`;
};

// A list entry's name, marked when it is Inactive now, or "-" for none.
const entryLine = (entry: ReceiptListEntry | null): string => (entry === null ? '-' : entry.is_active ? entry.name : `${entry.name} (${INACTIVE_LABEL})`);

const MaterialReceiptDetailContent: React.FC<{ id: string }> = ({ id }) => {
  const navigate = useNavigate();
  const [action, setAction] = useState<Action | null>(null);

  const receipt = useQuery<ReceiptDetail, Error & { status?: number }>({
    queryKey: ['material-receipt', id],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/material-receipts/${encodeURIComponent(id)}`, { credentials: 'include', signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
  });

  const isSignedOut = receipt.error?.status === 401;
  useEffect(() => {
    if (isSignedOut) {
      navigate('/login', { replace: true });
    }
  }, [isSignedOut, navigate]);

  // A failed read hides what an earlier one showed: a lost grant fails closed.
  const detail = receipt.isError ? undefined : receipt.data;
  const isForbidden = receipt.error?.status === 403 || receipt.error?.status === 404 || receipt.error?.status === 400;
  const mayManage = detail?.can_manage === true && detail.state === 'DRAFT';
  // Each action waits for the token: a request sent without it is refused as if the grant were gone (#135).
  const session = useCsrfToken(mayManage);
  const csrfToken = session.data ?? null;
  const offersActions = mayManage && csrfToken !== null && action === null;
  // The open form closes once the Material Receipt is no longer a Draft.
  const acting = mayManage ? action : null;
  // The amounts for reference only, worked out from each line and never stored (Q8).
  const amounts = (detail?.lines ?? []).map((line) => lineAmount(line.quantity ?? '', line.unit_price ?? ''));
  const total = amounts.some((amount) => amount !== null) ? amounts.reduce<bigint>((sum, amount) => sum + (amount ?? 0n), 0n) : null;

  return (
    <main style={{ minHeight: '100vh', backgroundColor: '#f3f4f6', padding: '1rem', fontFamily: 'system-ui, -apple-system, sans-serif', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: '1000px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1)', padding: '1.25rem', boxSizing: 'border-box' }}>
        <Link to="/material-receipts" id="back-material-receipt-list-link" style={{ color: '#4b5563', textDecoration: 'none', fontSize: '0.875rem', fontWeight: 500 }}>
          ← กลับสู่{MATERIAL_RECEIPT_LABEL}
        </Link>

        {receipt.isError && !isSignedOut && (
          <div role="alert" id="material-receipt-error" style={{ padding: '0.75rem 1rem', margin: '1rem 0', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            {LOAD_ERRORS[Number(receipt.error.status)] ?? `เกิดข้อผิดพลาดในการโหลด${MATERIAL_RECEIPT_LABEL}`}{' '}
            {!isForbidden && (
              <button type="button" id="material-receipt-retry" onClick={() => receipt.refetch()}>
                ลองใหม่
              </button>
            )}
          </div>
        )}

        {receipt.isPending && (
          <div role="status" aria-busy="true" style={{ padding: '2rem', textAlign: 'center', color: '#6b7280', fontSize: '0.875rem' }}>
            กำลังโหลด{MATERIAL_RECEIPT_LABEL}...
          </div>
        )}

        {detail && (
          <>
            {/* Named by its Receipt Number once Received, or as a Draft (P1). */}
            <h1 data-testid="material-receipt-heading" style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: '1rem 0 0.5rem 0' }}>
              {MATERIAL_RECEIPT_LABEL} {detail.receipt_number === null ? MATERIAL_RECEIPT_STATE_LABELS.DRAFT : receiptNumberLine(detail.receipt_number)}
            </h1>
            <p style={{ margin: '0 0 1.25rem 0', fontSize: '0.9375rem', color: '#374151' }}>
              <span
                data-testid="material-receipt-state"
                style={{ padding: '0.125rem 0.5rem', backgroundColor: detail.state === 'DRAFT' ? '#fef3c7' : '#dcfce7', color: detail.state === 'DRAFT' ? '#92400e' : '#166534', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 600 }}
              >
                {MATERIAL_RECEIPT_STATE_LABELS[detail.state]}
              </span>
            </p>

            <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.5rem 1.5rem', fontSize: '0.875rem', margin: '0 0 1.5rem 0' }}>
              <dt style={{ fontWeight: 500, color: '#4b5563' }}>{RECEIVED_DATE_LABEL}</dt>
              <dd data-testid="material-receipt-received-date" style={{ margin: 0 }}>{detail.received_date === null ? '-' : thaiDate(detail.received_date)}</dd>
              <dt style={{ fontWeight: 500, color: '#4b5563' }}>{SOURCE_PARTY_LABEL}</dt>
              <dd data-testid="material-receipt-source-party" style={{ margin: 0 }}>{entryLine(detail.source_party)}</dd>
              <dt style={{ fontWeight: 500, color: '#4b5563' }}>{SOURCE_TYPE_LABEL}</dt>
              <dd data-testid="material-receipt-source-type" style={{ margin: 0 }}>{entryLine(detail.source_type)}</dd>
              <dt style={{ fontWeight: 500, color: '#4b5563' }}>{RECEIPT_REFERENCE_LABEL}</dt>
              <dd data-testid="material-receipt-reference" style={{ margin: 0, whiteSpace: 'pre-line' }}>{detail.receipt_reference ?? '-'}</dd>
              <dt style={{ fontWeight: 500, color: '#4b5563' }}>หมายเหตุ</dt>
              <dd style={{ margin: 0, whiteSpace: 'pre-line' }}>{detail.note ?? '-'}</dd>
              <dt style={{ fontWeight: 500, color: '#4b5563' }}>บันทึกโดย</dt>
              <dd style={{ margin: 0 }}>
                {detail.created_by_username ?? '-'} เมื่อ {THAI_DATE_TIME.format(new Date(detail.created_at))}
              </dd>
              {detail.confirmed_at !== null && (
                <>
                  <dt style={{ fontWeight: 500, color: '#4b5563' }}>ยืนยันโดย</dt>
                  <dd data-testid="material-receipt-confirmed" style={{ margin: 0 }}>
                    {detail.confirmed_by_username ?? '-'} เมื่อ {THAI_DATE_TIME.format(new Date(detail.confirmed_at))}
                  </dd>
                </>
              )}
            </dl>

            {offersActions && (
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
                <Link to={`/material-receipts/${id}/edit`} id="material-receipt-edit-action" style={{ ...actionStyle, backgroundColor: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db' }}>
                  {EDIT_DRAFT_LABEL}
                </Link>
                <button type="button" id="material-receipt-confirm-action" onClick={() => setAction('confirm')} style={{ ...actionStyle, backgroundColor: '#2563eb', color: '#ffffff' }}>
                  {CONFIRM_RECEIPT_LABEL}
                </button>
                <button type="button" id="material-receipt-remove-action" onClick={() => setAction('remove')} style={{ ...actionStyle, backgroundColor: '#fee2e2', color: '#991b1b' }}>
                  {REMOVE_DRAFT_LABEL}
                </button>
              </div>
            )}

            {acting !== null && csrfToken !== null && (
              <LoanSaveForm
                idPrefix={`material-receipt-${acting}`}
                heading={acting === 'confirm' ? CONFIRM_RECEIPT_LABEL : REMOVE_DRAFT_LABEL}
                saveUrl={`/material-receipts/${encodeURIComponent(id)}/${acting}`}
                csrfToken={csrfToken}
                requestError={() => null}
                requestBody={() => ({ expected_version: detail.version })}
                refusedList={(body) =>
                  Array.isArray(body?.problems) ? (
                    <>
                      <p style={{ margin: '0 0 0.5rem 0' }}>ยังยืนยันไม่ได้ กรุณาแก้ไขร่างตามรายการนี้</p>
                      <ul data-testid="material-receipt-confirm-problems" style={{ margin: 0, paddingLeft: '1.25rem' }}>
                        {(body!.problems as ReceiptConfirmProblem[]).map((problem, index) => (
                          <li key={index}>
                            {problemLine(problem)}
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
                refusedMessage={acting === 'confirm' ? `ไม่สามารถ${CONFIRM_RECEIPT_LABEL}ได้` : `ไม่สามารถ${REMOVE_DRAFT_LABEL}ได้`}
                staleMessage="มีผู้แก้ไขร่างนี้ไปแล้ว กรุณาโหลดใหม่"
                submitLabel={acting === 'confirm' ? CONFIRM_RECEIPT_LABEL : REMOVE_DRAFT_LABEL}
                onRefresh={async () => (await receipt.refetch()).isSuccess}
                onSaved={async () => {
                  setAction(null);
                  if (acting === 'remove') {
                    navigate('/material-receipts');
                    return;
                  }
                  await receipt.refetch();
                }}
                onCancel={() => setAction(null)}
                onPermissionRevoked={() => void receipt.refetch()}
              >
                {() => (
                  <p data-testid={`material-receipt-${acting}-notice`} style={{ fontSize: '0.875rem', color: '#4b5563', margin: '0 0 1rem 0' }}>
                    {acting === 'confirm'
                      ? `เมื่อยืนยันแล้ว ระบบจะออกเลขที่รับและบันทึก${STOCK_MOVEMENT_LABEL}ของทุกรายการ แก้ไขร่างนี้ไม่ได้อีก`
                      : 'ร่างนี้จะถูกลบออกจากระบบและกู้คืนไม่ได้'}
                  </p>
                )}
              </LoanSaveForm>
            )}

            <h2 style={{ fontSize: '1.125rem', fontWeight: 600, color: '#111827', margin: '0 0 0.75rem 0' }}>รายการ ({detail.lines.length})</h2>
            {detail.lines.length === 0 ? (
              <p id="material-receipt-lines-empty" style={{ fontSize: '0.875rem', color: '#6b7280' }}>
                ยังไม่มีรายการ
              </p>
            ) : (
              <div style={{ overflowX: 'auto', marginBottom: '1.5rem' }}>
                <table id="material-receipt-lines-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.875rem' }}>
                  <thead>
                    <tr style={{ backgroundColor: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                      <th style={headStyle}>ลำดับ</th>
                      <th style={headStyle}>วัสดุ</th>
                      <th style={headStyle}>จำนวน</th>
                      <th style={headStyle}>{UNIT_LABEL}</th>
                      <th style={headStyle}>{UNIT_PRICE_LABEL}</th>
                      <th style={headStyle}>{AMOUNT_LABEL}</th>
                      <th style={headStyle}>{STOCK_MOVEMENT_LABEL}</th>
                      <th style={headStyle}>หมายเหตุ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((line) => {
                      const movement = line.stock_movements.find((recorded) => recorded.id === line.stock_movement_id);
                      return (
                        <tr key={line.id} data-testid={`material-receipt-line-${line.position}`} style={{ borderBottom: '1px solid #e5e7eb' }}>
                          <td style={cellStyle}>{line.position + 1}</td>
                          <td style={cellStyle}>
                            <Link to={`/stock-materials/${line.stock_material.id}`} style={{ color: '#2563eb', textDecoration: 'underline' }}>
                              {line.stock_material.name}
                            </Link>
                            {!line.stock_material.is_active && ` (${INACTIVE_LABEL})`}
                          </td>
                          <td style={cellStyle}>{line.quantity ?? '-'}</td>
                          <td style={cellStyle}>{line.unit?.name ?? '-'}</td>
                          <td style={cellStyle}>{line.unit_price ?? '-'}</td>
                          <td style={cellStyle}>{amounts[line.position] === null ? '-' : formatAmount(amounts[line.position]!)}</td>
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
                {total !== null && (
                  <p style={{ fontSize: '0.875rem', color: '#374151', margin: '0.5rem 0 0 0' }}>
                    {AMOUNT_LABEL}รวม <strong data-testid="material-receipt-total-amount">{formatAmount(total)}</strong> ({AMOUNT_FOR_REFERENCE_LABEL})
                  </p>
                )}
              </div>
            )}

            {detail.history.length > 0 && (
              <section aria-label="ประวัติ">
                <h2 style={{ fontSize: '1.125rem', fontWeight: 600, color: '#111827', margin: '0 0 0.75rem 0' }}>ประวัติ</h2>
                <ol id="material-receipt-history" style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.875rem', color: '#374151' }}>
                  {detail.history.map((entry) => (
                    <li key={entry.version} data-testid={`material-receipt-history-${entry.version}`} style={{ marginBottom: '0.5rem' }}>
                      {MATERIAL_RECEIPT_HISTORY_KIND_LABELS[entry.kind]} โดย {entry.recorded_by_username ?? '-'} เมื่อ {THAI_DATE_TIME.format(new Date(entry.recorded_at))}
                      {entry.reason !== null && <div style={{ color: '#4b5563', whiteSpace: 'pre-line' }}>เหตุผล: {entry.reason}</div>}
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
 * F010-T3 (#234): a Material Receipt's page: its Receipt Number and state, วันที่รับ, แหล่งที่มา, วิธีได้มา, เอกสารอ้างอิง
 * and note, each line with its Stock Material, quantity, Unit, ราคาต่อหน่วย, its amount for reference only and the Stock
 * Movement it made, and its history; on a Draft, "แก้ไขร่าง", "ยืนยันรับวัสดุ" with every failing rule listed, and
 * "ลบร่าง" for a Supply Officer (#231 story 58, Q24, Q25).
 */
export const MaterialReceiptDetail: React.FC = () => {
  const { id = '' } = useParams();
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <MaterialReceiptDetailContent id={id} />
    </QueryClientProvider>
  );
};
