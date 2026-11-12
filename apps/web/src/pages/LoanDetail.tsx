import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { DueDateExtensionForm } from '../components/DueDateExtensionForm';
import { OverdueBadge, ReturnedLateBadge, VoidedMark } from '../components/LoanBadges';
import { LoanConflictMarks } from '../components/LoanConflicts';
import { LoanAmendForm, LoanVoidForm } from '../components/LoanCorrectionForms';
import { LoanCorrectionList, correctionTargetText } from '../components/LoanCorrectionList';
import { LoanReturnForm } from '../components/LoanReturnForm';
import { NotReturnedForm } from '../components/NotReturnedForm';
import { RepairStartForm } from '../components/RepairStartForm';
import { entryLabel } from '../components/ReferenceContextFields';
import { CORRECTION_LABELS, thaiDate } from '../components/assignmentFacts';
import {
  CONDITION_LABELS,
  DUE_DATE_EXTENSION_LABEL,
  NOT_RETURNED_LABEL,
  OUTSTANDING_LABEL,
  VOIDED_COUNTS_IN_NOTHING,
  VOIDED_LABEL,
  assetLabel,
  borrowerText,
  isOutstanding,
  isReturnable,
  loanReturnText,
  loanStatusText,
  voidedStyle,
  type Loan,
  type LoanCorrectionTarget,
} from '../components/loanFacts';
import { REPAIR_KIND_LABELS, REPAIR_START_LABEL, type CitingRepairRecord } from '../components/repairFacts';

const THAI_DATE_TIME = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

const LOAD_ERRORS: Record<number, string> = {
  403: 'คุณไม่มีสิทธิ์เข้าถึงข้อมูลการยืมนี้ (403 Forbidden)',
  404: 'ไม่พบข้อมูลการยืมที่ระบุ (404 Not Found)',
};

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  padding: '1.5rem',
  boxSizing: 'border-box',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  backgroundColor: '#f5f5f5',
};

const cardStyle: React.CSSProperties = {
  maxWidth: '800px',
  margin: '0 auto',
  backgroundColor: '#ffffff',
  borderRadius: '8px',
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
  padding: '2rem',
  boxSizing: 'border-box',
};

const termStyle: React.CSSProperties = { fontWeight: 500, color: '#4b5563' };
const valueStyle: React.CSSProperties = { margin: 0, color: '#111827' };
const noneStyle: React.CSSProperties = { color: '#9ca3af' };

const orNone = (value: string | null): React.ReactNode => value ?? <span style={noneStyle}>ไม่ระบุ</span>;

// The writes on a Loan, one form open at a time: a recording, a correction of one fact (F004-T6), or a
// send for repair from one Loan Return (F005-T5).
type LoanForm = 'return' | 'extension' | 'not-returned' | { correction: 'AMEND' | 'VOID'; target: LoanCorrectionTarget } | { repairFrom: string };

const actionStyle: React.CSSProperties = {
  padding: '0.5rem 1rem',
  backgroundColor: '#2563eb',
  color: '#ffffff',
  border: 'none',
  borderRadius: '6px',
  fontSize: '0.875rem',
  fontWeight: 500,
  cursor: 'pointer',
};

const secondaryActionStyle: React.CSSProperties = { ...actionStyle, backgroundColor: '#ffffff', color: '#374151', border: '1px solid #d1d5db' };

const correctionActionStyle: React.CSSProperties = {
  padding: '0.125rem 0.5rem',
  marginRight: '0.375rem',
  backgroundColor: '#ffffff',
  color: '#374151',
  border: '1px solid #d1d5db',
  borderRadius: '4px',
  fontSize: '0.75rem',
  cursor: 'pointer',
};

// The Repair Records that cite a Loan Return as their Repair Source, each linked (F005-T5, RM-08).
const CitingRepairRecords: React.FC<{ records: CitingRepairRecord[] | undefined; testId: string }> = ({ records, testId }) =>
  records && records.length > 0 ? (
    <ul data-testid={testId} style={{ margin: '0.25rem 0', paddingLeft: '1.25rem', color: '#4b5563' }}>
      {records.map((record) => (
        <li key={record.id}>
          <Link to={`/repairs/${record.id}`} style={{ color: '#2563eb', textDecoration: 'underline', ...(record.is_voided ? voidedStyle : {}) }}>
            {REPAIR_START_LABEL}แล้ว: {REPAIR_KIND_LABELS[record.repair_kind]} วันที่ส่งซ่อม <time dateTime={record.start_date}>{thaiDate(record.start_date)}</time>
          </Link>
          {record.is_voided && <VoidedMark testId={`loan-repair-record-voided-${record.id}`} />}
        </li>
      ))}
    </ul>
  ) : null;

const LoanDetailContent: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [openForm, setOpenForm] = useState<LoanForm | null>(null);

  const loan = useQuery<Loan, Error & { status?: number }>({
    queryKey: ['loan', id],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/loans/${id}`, { credentials: 'include', signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
  });

  // The write forms need this session's CSRF token, and a correction's Person lists the user.
  const canRecordLoan = loan.data?.can_record_loan === true;
  const canCorrectLoan = loan.data?.can_correct_loan === true;
  const canRecordRepair = loan.data?.can_record_repair === true;
  const session = useQuery<{ csrfToken: string | null; userId: string | null } | null>({
    queryKey: ['loan-session', id],
    queryFn: async ({ signal }) => {
      const res = await fetch('/auth/session-check', { credentials: 'include', signal });
      if (!res.ok) {
        return null;
      }
      const body = await res.json();
      return { csrfToken: body.csrfToken ?? null, userId: body.user?.id ?? null };
    },
    enabled: canRecordLoan || canCorrectLoan || canRecordRepair,
  });

  const isSignedOut = loan.error?.status === 401;
  useEffect(() => {
    if (isSignedOut) {
      navigate('/login', { replace: true });
    }
  }, [isSignedOut, navigate]);

  // A failed read hides what an earlier one showed: a lost grant fails closed.
  if (loan.isError) {
    return (
      <main style={pageStyle}>
        <div style={{ ...cardStyle, textAlign: 'center' }}>
          <div role="alert" id="loan-load-error" style={{ padding: '1rem', backgroundColor: '#fee2e2', color: '#991b1b', borderRadius: '6px', marginBottom: '1.5rem', fontWeight: 500 }}>
            {LOAD_ERRORS[loan.error.status ?? 0] ?? 'เกิดข้อผิดพลาดในการโหลดข้อมูลการยืม'}
          </div>
          <Link to="/dashboard" style={{ color: '#2563eb', textDecoration: 'none', fontWeight: 500, fontSize: '0.875rem' }}>
            ← กลับไปยังแดชบอร์ด
          </Link>
        </div>
      </main>
    );
  }

  if (!loan.data) {
    return (
      <main style={{ ...pageStyle, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        <div role="status" aria-live="polite" style={{ color: '#4b5563' }}>
          กำลังโหลดข้อมูลการยืม...
        </div>
      </main>
    );
  }

  const { borrower, loan_date: loanDate, authorizer, document_reference: documentReference, remark, recorded_by: recordedBy, recorded_by_username: recordedByUsername, recorded_at: recordedAt, status, is_overdue: isOverdue, is_voided: isVoided, items, corrections } = loan.data;
  const counted = items.filter(({ is_voided: isVoided }) => !isVoided);
  const returnedCount = counted.filter(({ ending_kind: endingKind }) => endingKind === 'LOAN_RETURN').length;
  const notReturnedCount = counted.filter(({ ending_kind: endingKind }) => endingKind === 'NOT_RETURNED').length;
  // A Loan Return also takes an item closed as Not Returned; the other writes take Outstanding items only.
  const mayReturn = canRecordLoan && items.some(isReturnable);
  const mayChangeOutstanding = canRecordLoan && items.some(isOutstanding);
  // A voided fact is neither amended nor voided again (#74 Q25).
  const mayCorrect = canCorrectLoan && !isVoided;
  const formProps = {
    loan: loan.data,
    csrfToken: session.data?.csrfToken ?? null,
    onRecorded: async () => {
      await loan.refetch();
      setOpenForm(null);
    },
    onRefresh: async () => {
      const result = await loan.refetch();
      return result.isError ? null : (result.data?.version ?? null);
    },
    onCancel: () => setOpenForm(null),
    onPermissionRevoked: (statusCode?: number) => {
      if (statusCode === 401) {
        navigate('/login', { replace: true });
        return;
      }
      void loan.refetch();
    },
  };
  const openCorrection = typeof openForm === 'object' && openForm !== null && 'correction' in openForm ? openForm : null;
  const repairFrom = typeof openForm === 'object' && openForm !== null && 'repairFrom' in openForm ? openForm.repairFrom : null;
  const correctionProps = (target: LoanCorrectionTarget) => ({
    ...formProps,
    target,
    targetLabel: correctionTargetText(loan.data, target),
    actorId: session.data?.userId ?? null,
  });
  // "แก้ไขรายการที่บันทึกผิด" and "ยกเลิกรายการ (บันทึกผิด)" for one fact, to holders of 'loan:correct'. A
  // Due Date Extension is voided and recorded again, never amended (#74 Q25).
  const correctionActions = (idPrefix: string, target: LoanCorrectionTarget, amendable: boolean = true) =>
    mayCorrect &&
    openForm === null && (
      <div style={{ marginTop: '0.25rem' }}>
        {amendable && (
          <button type="button" id={`${idPrefix}-amend-action`} onClick={() => setOpenForm({ correction: 'AMEND', target })} style={correctionActionStyle}>
            {CORRECTION_LABELS.AMENDED}
          </button>
        )}
        <button type="button" id={`${idPrefix}-void-action`} onClick={() => setOpenForm({ correction: 'VOID', target })} style={correctionActionStyle}>
          {CORRECTION_LABELS.VOIDED}
        </button>
      </div>
    );

  return (
    <main style={pageStyle}>
      <div style={cardStyle}>
        <Link to="/dashboard" id="nav-dashboard-link" style={{ color: '#2563eb', textDecoration: 'none', fontSize: '0.875rem' }}>
          ← กลับไปยังแดชบอร์ด
        </Link>
        <span style={{ color: '#d1d5db', margin: '0 0.75rem' }}>|</span>
        <Link to="/loans" id="nav-loan-list-link" style={{ color: '#2563eb', textDecoration: 'none', fontSize: '0.875rem' }}>
          รายการยืม
        </Link>
        <h1 id="loan-detail-heading" style={{ fontSize: '1.5rem', fontWeight: 600, margin: '0.75rem 0 1.5rem 0', color: '#111827' }}>
          การยืม
        </h1>

        {isVoided && (
          <div data-testid="loan-voided" role="note" style={{ padding: '0.75rem 1rem', backgroundColor: '#fee2e2', color: '#991b1b', borderRadius: '6px', marginBottom: '1rem', fontWeight: 600 }}>
            {VOIDED_LABEL}: การยืมนี้ไม่เคยเกิดขึ้นจริง และ{VOIDED_COUNTS_IN_NOTHING}
          </div>
        )}

        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.75rem 1.5rem', margin: '0 0 1rem 0', fontSize: '0.9375rem', backgroundColor: '#f9fafb', padding: '1.25rem', borderRadius: '6px', ...(isVoided ? voidedStyle : {}) }}>
          <dt style={termStyle}>สถานะ:</dt>
          <dd id="loan-status" style={valueStyle}>
            {loanStatusText(status, notReturnedCount)}
            {status !== null && ` (คืนแล้ว ${returnedCount} จาก ${counted.length} รายการ)`}
            {isOverdue && <OverdueBadge id="loan-overdue" />}
          </dd>
          <dt style={termStyle}>ผู้ยืม:</dt>
          <dd id="loan-borrower" style={valueStyle}>
            {borrowerText(borrower)}
          </dd>
          {borrower.kind === 'EXTERNAL' && borrower.phone !== undefined && (
            <>
              <dt style={termStyle}>เบอร์โทร:</dt>
              <dd id="loan-borrower-phone" style={valueStyle}>
                {orNone(borrower.phone)}
              </dd>
            </>
          )}
          <dt style={termStyle}>วันที่ยืม:</dt>
          <dd id="loan-date" style={valueStyle}>
            <time dateTime={loanDate}>{thaiDate(loanDate)}</time>
          </dd>
          <dt style={termStyle}>ผู้อนุญาต:</dt>
          <dd id="loan-authorizer" style={valueStyle}>
            {authorizer ? entryLabel(authorizer) : orNone(null)}
          </dd>
          <dt style={termStyle}>เอกสารอ้างอิง:</dt>
          <dd id="loan-document-reference" style={valueStyle}>
            {orNone(documentReference)}
          </dd>
          <dt style={termStyle}>หมายเหตุ:</dt>
          <dd id="loan-remark" style={valueStyle}>
            {orNone(remark)}
          </dd>
          <dt style={termStyle}>ผู้บันทึก:</dt>
          <dd id="loan-recorded-by" style={valueStyle}>
            {recordedByUsername ?? recordedBy}
          </dd>
          <dt style={termStyle}>วันที่บันทึก:</dt>
          <dd id="loan-recorded-at" style={valueStyle}>
            <time dateTime={recordedAt}>{THAI_DATE_TIME.format(new Date(recordedAt))}</time>
          </dd>
        </dl>
        {correctionActions('loan', { kind: 'LOAN' })}

        {openCorrection && (
          <div style={{ marginTop: '1rem' }}>
            {openCorrection.correction === 'AMEND' ? (
              <LoanAmendForm {...correctionProps(openCorrection.target)} />
            ) : (
              <LoanVoidForm {...correctionProps(openCorrection.target)} />
            )}
          </div>
        )}
        {mayReturn && openForm === 'return' && <LoanReturnForm {...formProps} />}
        {mayChangeOutstanding && openForm === 'extension' && <DueDateExtensionForm {...formProps} />}
        {mayChangeOutstanding && openForm === 'not-returned' && <NotReturnedForm {...formProps} />}
        {(mayReturn || mayChangeOutstanding) && openForm === null && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', margin: '1rem 0' }}>
            {mayReturn && (
              <button type="button" id="loan-return-action" onClick={() => setOpenForm('return')} style={actionStyle}>
                คืน
              </button>
            )}
            {mayChangeOutstanding && (
              <>
                <button type="button" id="loan-extension-action" onClick={() => setOpenForm('extension')} style={secondaryActionStyle}>
                  {DUE_DATE_EXTENSION_LABEL}
                </button>
                <button type="button" id="loan-not-returned-action" onClick={() => setOpenForm('not-returned')} style={secondaryActionStyle}>
                  {NOT_RETURNED_LABEL}
                </button>
              </>
            )}
          </div>
        )}

        <h2 style={{ fontSize: '1.125rem', fontWeight: 600, marginTop: '1.5rem', marginBottom: '1rem', color: '#374151' }}>รายการยืม</h2>
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {items.map((item) => (
            <li key={item.id} data-testid="loan-item" style={{ borderTop: '1px solid #e5e7eb', padding: '0.75rem 0', fontSize: '0.875rem', color: '#374151' }}>
              <div style={item.is_voided ? voidedStyle : undefined}>
                <Link to={`/assets/${item.asset.id}`} style={{ color: '#2563eb', textDecoration: 'underline', fontWeight: 500 }}>
                  {assetLabel(item.asset)}
                </Link>
                {item.asset.asset_number && item.asset.name && <span style={{ color: '#6b7280' }}> ({item.asset.asset_number})</span>}
                {item.is_voided && <VoidedMark testId={`loan-item-voided-${item.id}`} />}
                <div>
                  กำหนดคืน: <time dateTime={item.due_date}>{thaiDate(item.due_date)}</time>
                </div>
                <div>
                  สภาพ: {CONDITION_LABELS[item.condition]}
                  {item.condition_note ? ` (${item.condition_note})` : ''}
                </div>
              </div>
              <LoanConflictMarks conflicts={item.conflicts} testId={`loan-item-conflicts-${item.id}`} />
              {!item.is_voided && correctionActions(`loan-item-${item.id}`, { kind: 'LOAN_ITEM', id: item.id })}
              {item.due_date_extensions.length > 0 && (
                <ul data-testid="loan-item-extensions" style={{ margin: '0.25rem 0', paddingLeft: '1.25rem', color: '#4b5563' }}>
                  {item.due_date_extensions.map((extension) => (
                    <li key={extension.id} data-testid="loan-item-extension">
                      <span style={extension.is_voided ? voidedStyle : undefined}>
                        {DUE_DATE_EXTENSION_LABEL}: <time dateTime={extension.prior_due_date}>{thaiDate(extension.prior_due_date)}</time> →{' '}
                        <time dateTime={extension.new_due_date}>{thaiDate(extension.new_due_date)}</time>
                        {extension.reason && ` · เหตุผล: ${extension.reason}`} · ผู้บันทึก: {extension.recorded_by_username ?? extension.recorded_by} ·{' '}
                        <time dateTime={extension.recorded_at}>{THAI_DATE_TIME.format(new Date(extension.recorded_at))}</time>
                      </span>
                      {extension.is_voided && <VoidedMark testId={`loan-extension-voided-${extension.id}`} />}
                      {!extension.is_voided && correctionActions(`loan-extension-${extension.id}`, { kind: 'DUE_DATE_EXTENSION', id: extension.id }, false)}
                    </li>
                  ))}
                </ul>
              )}
              {item.not_returned && (
                <div data-testid="loan-item-not-returned">
                  <div>
                    {NOT_RETURNED_LABEL}: <time dateTime={item.not_returned.not_returned_date}>{thaiDate(item.not_returned.not_returned_date)}</time>
                  </div>
                  <div style={{ whiteSpace: 'pre-line' }}>เหตุผล: {item.not_returned.reason}</div>
                  <div>
                    ผู้บันทึก: {item.not_returned.recorded_by_username ?? item.not_returned.recorded_by} ·{' '}
                    <time dateTime={item.not_returned.recorded_at}>{THAI_DATE_TIME.format(new Date(item.not_returned.recorded_at))}</time>
                  </div>
                  {correctionActions(`loan-not-returned-${item.not_returned.id}`, { kind: 'NOT_RETURNED', id: item.not_returned.id })}
                </div>
              )}
              {item.loan_return ? (
                <div data-testid="loan-item-return">
                  <div>
                    คืนแล้ว: <time dateTime={item.loan_return.return_date}>{thaiDate(item.loan_return.return_date)}</time> · {loanReturnText(item.loan_return)}
                    {item.loan_return.returned_after_due_date && <ReturnedLateBadge testId="loan-item-returned-late" />}
                  </div>
                  {item.loan_return.document_reference && <div>เอกสารอ้างอิงการคืน: {item.loan_return.document_reference}</div>}
                  {item.loan_return.remark && <div>หมายเหตุการคืน: {item.loan_return.remark}</div>}
                  <div>ผู้บันทึกการคืน: {item.loan_return.recorded_by_username ?? item.loan_return.recorded_by}</div>
                  <CitingRepairRecords records={item.loan_return.repair_records} testId={`loan-return-repair-records-${item.loan_return.id}`} />
                  {correctionActions(`loan-return-${item.loan_return.id}`, { kind: 'LOAN_RETURN', id: item.loan_return.id })}
                  {/* "ส่งซ่อม" from a Loan Return recorded ชำรุด: nothing is saved until the form is (#98 Q5). */}
                  {canRecordRepair && openForm === null && item.loan_return.condition === 'DAMAGED' && (
                    <button type="button" id={`loan-return-${item.loan_return.id}-repair-action`} onClick={() => setOpenForm({ repairFrom: item.loan_return!.id })} style={{ ...secondaryActionStyle, marginTop: '0.375rem' }}>
                      {REPAIR_START_LABEL}
                    </button>
                  )}
                  {canRecordRepair && repairFrom === item.loan_return.id && (
                    <div style={{ marginTop: '0.75rem' }}>
                      <RepairStartForm
                        assetId={item.asset.id}
                        repairSource={{ loanReturnId: item.loan_return.id, returnDate: item.loan_return.return_date, conditionNote: item.loan_return.condition_note }}
                        csrfToken={formProps.csrfToken}
                        onStarted={formProps.onRecorded}
                        onCancel={formProps.onCancel}
                        onPermissionRevoked={formProps.onPermissionRevoked}
                      />
                    </div>
                  )}
                </div>
              ) : (
                isOutstanding(item) && (
                  <div>
                    <span data-testid="loan-item-outstanding">{OUTSTANDING_LABEL}</span>
                    {item.is_overdue && <OverdueBadge testId="loan-item-overdue" />}
                  </div>
                )
              )}
              {item.voided_endings.map((ending) => (
                <div key={ending.id} data-testid={`loan-ending-voided-${ending.id}`}>
                  <span style={voidedStyle}>
                    {ending.kind === 'LOAN_RETURN' ? (
                      <>
                        คืนแล้ว: <time dateTime={ending.return_date}>{thaiDate(ending.return_date)}</time> · {loanReturnText(ending)}
                      </>
                    ) : (
                      <>
                        {NOT_RETURNED_LABEL}: <time dateTime={ending.not_returned_date}>{thaiDate(ending.not_returned_date)}</time> · เหตุผล: {ending.reason}
                      </>
                    )}
                  </span>
                  <VoidedMark testId={`loan-ending-voided-mark-${ending.id}`} />
                  {ending.kind === 'LOAN_RETURN' && <CitingRepairRecords records={ending.repair_records} testId={`loan-return-repair-records-${ending.id}`} />}
                </div>
              ))}
            </li>
          ))}
        </ol>

        {corrections.length > 0 && <LoanCorrectionList loan={loan.data} corrections={corrections} />}
      </div>
    </main>
  );
};

export const LoanDetail: React.FC = () => {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <LoanDetailContent />
    </QueryClientProvider>
  );
};
