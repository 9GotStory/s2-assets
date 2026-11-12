import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { VoidedMark } from '../components/LoanBadges';
import { RepairAmendForm, RepairVoidForm } from '../components/RepairCorrectionForms';
import { RepairCorrectionList } from '../components/RepairCorrectionList';
import { RepairOutcomeForm } from '../components/RepairOutcomeForm';
import { CORRECTION_LABELS, thaiDate } from '../components/assignmentFacts';
import { CONDITION_LABELS, VOIDED_LABEL, assetLabel, voidedStyle } from '../components/loanFacts';
import {
  NEXT_RECOMMENDED_MAINTENANCE_DATE_LABEL,
  OUTCOME_DATE_LABEL,
  RECORD_REPAIR_OUTCOME_LABEL,
  REPAIR_KIND_LABELS,
  REPAIR_OUTCOME_LABEL,
  REPAIR_OUTCOME_LABELS,
  REPAIR_RECORD_LABEL,
  REPAIR_SOURCE_LABEL,
  UNDER_REPAIR_LABELS,
  UNDER_WARRANTY_LABELS,
  costText,
  repairerText,
  type RepairCorrectionTarget,
  type RepairKind,
  type RepairOutcome,
  type RepairRecord,
} from '../components/repairFacts';

const THAI_DATE_TIME = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

const LOAD_ERRORS: Record<number, string> = {
  403: 'คุณไม่มีสิทธิ์เข้าถึงข้อมูลรายการซ่อมนี้ (403 Forbidden)',
  404: 'ไม่พบรายการซ่อม/บำรุงรักษาที่ระบุ (404 Not Found)',
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

const orNone = (value: React.ReactNode | null): React.ReactNode => value ?? <span style={noneStyle}>ไม่ระบุ</span>;

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

// The writes on a Repair Record, one form open at a time: its outcome, or a correction of one fact (F005-T6).
type RepairForm = 'outcome' | { correction: 'AMEND' | 'VOID'; target: RepairCorrectionTarget };

// One Repair Outcome as the page shows it; a voided one stays shown, struck through (#98 Q18). `idPrefix`
// names its values: "repair-outcome" for the outcome that counts.
const OutcomeFacts: React.FC<{ outcome: RepairOutcome; repairKind: RepairKind; idPrefix: string; isVoided: boolean }> = ({ outcome, repairKind, idPrefix, isVoided }) => (
  <dl
    data-testid={idPrefix}
    style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.75rem 1.5rem', margin: '0 0 1rem 0', fontSize: '0.9375rem', backgroundColor: '#f9fafb', padding: '1.25rem', borderRadius: '6px', ...(isVoided ? voidedStyle : {}) }}
  >
    <dt style={termStyle}>{REPAIR_OUTCOME_LABEL}:</dt>
    <dd id={`${idPrefix}-value`} style={{ ...valueStyle, fontWeight: 600, color: isVoided ? undefined : outcome.outcome === 'USABLE' ? '#166534' : '#b91c1c' }}>
      {REPAIR_OUTCOME_LABELS[repairKind][outcome.outcome]}
      {isVoided && <VoidedMark testId={`${idPrefix}-voided`} />}
    </dd>
    <dt style={termStyle}>{OUTCOME_DATE_LABEL}:</dt>
    <dd id={`${idPrefix}-date`} style={valueStyle}>
      <time dateTime={outcome.outcome_date}>{thaiDate(outcome.outcome_date)}</time>
    </dd>
    <dt style={termStyle}>{NEXT_RECOMMENDED_MAINTENANCE_DATE_LABEL}:</dt>
    <dd id={`${idPrefix}-next-maintenance-date`} style={valueStyle}>
      {orNone(outcome.next_recommended_maintenance_date && <time dateTime={outcome.next_recommended_maintenance_date}>{thaiDate(outcome.next_recommended_maintenance_date)}</time>)}
    </dd>
    <dt style={termStyle}>เอกสารอ้างอิงของผล:</dt>
    <dd id={`${idPrefix}-document-reference`} style={{ ...valueStyle, whiteSpace: 'pre-line' }}>
      {orNone(outcome.document_reference)}
    </dd>
    <dt style={termStyle}>หมายเหตุของผล:</dt>
    <dd id={`${idPrefix}-note`} style={{ ...valueStyle, whiteSpace: 'pre-line' }}>
      {orNone(outcome.note)}
    </dd>
    <dt style={termStyle}>ผู้บันทึกผล:</dt>
    <dd id={`${idPrefix}-recorded-by`} style={valueStyle}>
      {outcome.recorded_by_username ?? outcome.recorded_by}
    </dd>
    <dt style={termStyle}>วันที่บันทึกผล:</dt>
    <dd id={`${idPrefix}-recorded-at`} style={valueStyle}>
      <time dateTime={outcome.recorded_at}>{THAI_DATE_TIME.format(new Date(outcome.recorded_at))}</time>
    </dd>
  </dl>
);

const RepairDetailContent: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [openForm, setOpenForm] = useState<RepairForm | null>(null);

  const record = useQuery<RepairRecord, Error & { status?: number }>({
    queryKey: ['repair', id],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/repairs/${id}`, { credentials: 'include', signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
  });

  // The write forms need this session's CSRF token.
  const canRecordRepair = record.data?.can_record_repair === true;
  const canCorrectRepair = record.data?.can_correct_repair === true;
  const session = useQuery<{ csrfToken: string | null } | null>({
    queryKey: ['repair-session', id],
    queryFn: async ({ signal }) => {
      const res = await fetch('/auth/session-check', { credentials: 'include', signal });
      if (!res.ok) {
        return null;
      }
      const body = await res.json();
      return { csrfToken: body.csrfToken ?? null };
    },
    enabled: canRecordRepair || canCorrectRepair,
  });

  const isSignedOut = record.error?.status === 401;
  useEffect(() => {
    if (isSignedOut) {
      navigate('/login', { replace: true });
    }
  }, [isSignedOut, navigate]);

  // A failed read hides what an earlier one showed: a lost grant fails closed.
  if (record.isError) {
    return (
      <main style={pageStyle}>
        <div style={{ ...cardStyle, textAlign: 'center' }}>
          <div role="alert" id="repair-load-error" style={{ padding: '1rem', backgroundColor: '#fee2e2', color: '#991b1b', borderRadius: '6px', marginBottom: '1.5rem', fontWeight: 500 }}>
            {LOAD_ERRORS[record.error.status ?? 0] ?? 'เกิดข้อผิดพลาดในการโหลดข้อมูลรายการซ่อม'}
          </div>
          <Link to="/dashboard" style={{ color: '#2563eb', textDecoration: 'none', fontWeight: 500, fontSize: '0.875rem' }}>
            ← กลับไปยังแดชบอร์ด
          </Link>
        </div>
      </main>
    );
  }

  if (!record.data) {
    return (
      <main style={{ ...pageStyle, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        <div role="status" aria-live="polite" style={{ color: '#4b5563' }}>
          กำลังโหลดข้อมูลรายการซ่อม...
        </div>
      </main>
    );
  }

  const { asset, repair_kind: repairKind, start_date: startDate, repairer, symptom_or_work: symptomOrWork, under_warranty: underWarranty, warranty_end_date: warrantyEndDate, cost, document_reference: documentReference, remark, repair_source: repairSource, recorded_by: recordedBy, recorded_by_username: recordedByUsername, recorded_at: recordedAt, is_voided: isVoided, outcome, voided_outcomes: voidedOutcomes, corrections = [] } = record.data;
  // In GLOSSARY.md terms only: a voided record keeps nobody's Asset, and one with its outcome shows it.
  const statusText = (): string => {
    if (isVoided) {
      return VOIDED_LABEL;
    }
    return outcome ? `${REPAIR_OUTCOME_LABEL}: ${REPAIR_OUTCOME_LABELS[repairKind][outcome.outcome]}` : UNDER_REPAIR_LABELS[repairKind];
  };
  // A voided record, or one that has its outcome, takes no other; the server would refuse it.
  const mayRecordOutcome = canRecordRepair && !isVoided && outcome === null;
  // A voided fact is neither amended nor voided again (#98 Q18).
  const mayCorrect = canCorrectRepair && !isVoided;

  const formProps = {
    record: record.data,
    csrfToken: session.data?.csrfToken ?? null,
    onRecorded: async () => {
      await record.refetch();
      setOpenForm(null);
    },
    onRefresh: async () => {
      const result = await record.refetch();
      return result.isError ? null : (result.data?.version ?? null);
    },
    onCancel: () => setOpenForm(null),
    onPermissionRevoked: (statusCode?: number) => {
      if (statusCode === 401) {
        navigate('/login', { replace: true });
        return;
      }
      void record.refetch();
    },
  };
  const openCorrection = typeof openForm === 'object' && openForm !== null ? openForm : null;
  const correctionForm = (target: RepairCorrectionTarget) =>
    openCorrection &&
    openCorrection.target.kind === target.kind && (
      <div style={{ margin: '1rem 0' }}>
        {openCorrection.correction === 'AMEND' ? (
          <RepairAmendForm {...formProps} target={openCorrection.target} targetLabel={target.kind === 'REPAIR_RECORD' ? REPAIR_RECORD_LABEL : REPAIR_OUTCOME_LABEL} />
        ) : (
          <RepairVoidForm {...formProps} target={openCorrection.target} targetLabel={target.kind === 'REPAIR_RECORD' ? REPAIR_RECORD_LABEL : REPAIR_OUTCOME_LABEL} />
        )}
      </div>
    );
  // "แก้ไขรายการที่บันทึกผิด" and "ยกเลิกรายการ (บันทึกผิด)" for one fact, to holders of 'repair:correct'.
  const correctionActions = (idPrefix: string, target: RepairCorrectionTarget) =>
    mayCorrect &&
    openForm === null && (
      <div style={{ margin: '0 0 1rem 0' }}>
        <button type="button" id={`${idPrefix}-amend-action`} onClick={() => setOpenForm({ correction: 'AMEND', target })} style={correctionActionStyle}>
          {CORRECTION_LABELS.AMENDED}
        </button>
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
        <h1 id="repair-detail-heading" style={{ fontSize: '1.5rem', fontWeight: 600, margin: '0.75rem 0 1.5rem 0', color: '#111827' }}>
          {REPAIR_RECORD_LABEL}
        </h1>

        {isVoided && (
          <div data-testid="repair-voided" role="note" style={{ padding: '0.75rem 1rem', backgroundColor: '#fee2e2', color: '#991b1b', borderRadius: '6px', marginBottom: '1rem', fontWeight: 600 }}>
            {VOIDED_LABEL}: รายการซ่อมนี้ไม่เคยเกิดขึ้นจริง และไม่นับรวมในสถานะใด
          </div>
        )}

        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.75rem 1.5rem', margin: '0 0 1rem 0', fontSize: '0.9375rem', backgroundColor: '#f9fafb', padding: '1.25rem', borderRadius: '6px', ...(isVoided ? voidedStyle : {}) }}>
          <dt style={termStyle}>สถานะ:</dt>
          <dd id="repair-status" style={valueStyle}>
            {statusText()}
          </dd>
          <dt style={termStyle}>ครุภัณฑ์:</dt>
          <dd style={valueStyle}>
            <Link to={`/assets/${asset.id}`} id="repair-asset" style={{ color: '#2563eb', textDecoration: 'underline' }}>
              {assetLabel(asset)}
            </Link>
            {asset.asset_number && asset.name && <span style={{ color: '#6b7280' }}> ({asset.asset_number})</span>}
          </dd>
          <dt style={termStyle}>ประเภท:</dt>
          <dd id="repair-kind" style={valueStyle}>
            {REPAIR_KIND_LABELS[repairKind]}
          </dd>
          <dt style={termStyle}>วันที่ส่งซ่อม:</dt>
          <dd id="repair-start-date" style={valueStyle}>
            <time dateTime={startDate}>{thaiDate(startDate)}</time>
          </dd>
          <dt style={termStyle}>ผู้ซ่อม:</dt>
          <dd id="repair-repairer" style={valueStyle}>
            {repairerText(repairer)}
          </dd>
          <dt style={termStyle}>อาการ/งานที่ทำ:</dt>
          <dd id="repair-symptom-or-work" style={{ ...valueStyle, whiteSpace: 'pre-line' }}>
            {symptomOrWork}
          </dd>
          <dt style={termStyle}>อยู่ในประกัน:</dt>
          <dd id="repair-under-warranty" style={valueStyle}>
            {UNDER_WARRANTY_LABELS[underWarranty]}
          </dd>
          <dt style={termStyle}>วันสิ้นสุดประกัน:</dt>
          <dd id="repair-warranty-end-date" style={valueStyle}>
            {orNone(warrantyEndDate && <time dateTime={warrantyEndDate}>{thaiDate(warrantyEndDate)}</time>)}
          </dd>
          <dt style={termStyle}>ค่าใช้จ่าย:</dt>
          <dd id="repair-cost" style={valueStyle}>
            {orNone(cost && costText(cost))}
          </dd>
          <dt style={termStyle}>เอกสารอ้างอิง:</dt>
          <dd id="repair-document-reference" style={{ ...valueStyle, whiteSpace: 'pre-line' }}>
            {orNone(documentReference)}
          </dd>
          <dt style={termStyle}>หมายเหตุ:</dt>
          <dd id="repair-remark" style={{ ...valueStyle, whiteSpace: 'pre-line' }}>
            {orNone(remark)}
          </dd>
          {/* A Loan Return voided later stays cited, struck through: nothing cascades (#98 Q5). */}
          <dt style={termStyle}>{REPAIR_SOURCE_LABEL}:</dt>
          <dd id="repair-source" style={valueStyle}>
            {repairSource ? (
              <>
                <span style={repairSource.is_voided ? voidedStyle : undefined}>
                  การคืนสภาพ{CONDITION_LABELS[repairSource.condition]} วันที่ <time dateTime={repairSource.return_date}>{thaiDate(repairSource.return_date)}</time>
                </span>
                {repairSource.is_voided && <VoidedMark testId="repair-source-voided" />}{' '}
                <Link to={`/loans/${repairSource.loan_id}`} id="repair-source-loan-link" style={{ color: '#2563eb', textDecoration: 'underline' }}>
                  ดูการยืม
                </Link>
              </>
            ) : (
              <span style={noneStyle}>ไม่มี</span>
            )}
          </dd>
          <dt style={termStyle}>ผู้บันทึก:</dt>
          <dd id="repair-recorded-by" style={valueStyle}>
            {recordedByUsername ?? recordedBy}
          </dd>
          <dt style={termStyle}>วันที่บันทึก:</dt>
          <dd id="repair-recorded-at" style={valueStyle}>
            <time dateTime={recordedAt}>{THAI_DATE_TIME.format(new Date(recordedAt))}</time>
          </dd>
        </dl>
        {correctionActions('repair', { kind: 'REPAIR_RECORD' })}
        {correctionForm({ kind: 'REPAIR_RECORD' })}

        <section aria-labelledby="repair-outcome-heading" style={{ marginTop: '1.5rem' }}>
          <h2 id="repair-outcome-heading" style={{ fontSize: '1.125rem', fontWeight: 600, margin: '0 0 1rem 0', color: '#374151' }}>
            {REPAIR_OUTCOME_LABEL}
          </h2>
          {outcome ? (
            <>
              <OutcomeFacts outcome={outcome} repairKind={repairKind} idPrefix="repair-outcome" isVoided={false} />
              {correctionActions('repair-outcome', { kind: 'REPAIR_OUTCOME', id: outcome.id })}
              {correctionForm({ kind: 'REPAIR_OUTCOME', id: outcome.id })}
            </>
          ) : (
            <p data-testid="repair-outcome-none" style={{ margin: '0 0 1rem 0', fontSize: '0.875rem', color: '#9ca3af' }}>
              ยังไม่มีผลการซ่อม
            </p>
          )}
          {voidedOutcomes.map((voided) => (
            <OutcomeFacts key={voided.id} outcome={voided} repairKind={repairKind} idPrefix={`repair-voided-outcome-${voided.id}`} isVoided />
          ))}

          {mayRecordOutcome && openForm === 'outcome' && <RepairOutcomeForm {...formProps} />}
          {mayRecordOutcome && openForm === null && (
            <button
              type="button"
              id="repair-outcome-action"
              onClick={() => setOpenForm('outcome')}
              style={{ padding: '0.5rem 1rem', backgroundColor: '#2563eb', color: '#ffffff', border: 'none', borderRadius: '6px', fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer' }}
            >
              {RECORD_REPAIR_OUTCOME_LABEL}
            </button>
          )}
        </section>

        {corrections.length > 0 && <RepairCorrectionList repairKind={repairKind} corrections={corrections} />}
      </div>
    </main>
  );
};

export const RepairDetail: React.FC = () => {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <RepairDetailContent />
    </QueryClientProvider>
  );
};
