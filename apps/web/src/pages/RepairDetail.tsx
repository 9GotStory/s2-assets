import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { thaiDate } from '../components/assignmentFacts';
import { assetLabel } from '../components/loanFacts';
import { REPAIR_KIND_LABELS, REPAIR_RECORD_LABEL, UNDER_WARRANTY_LABELS, costText, repairerText, type RepairRecord } from '../components/repairFacts';

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

const RepairDetailContent: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

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

  const { asset, repair_kind: repairKind, start_date: startDate, repairer, symptom_or_work: symptomOrWork, under_warranty: underWarranty, warranty_end_date: warrantyEndDate, cost, document_reference: documentReference, remark, recorded_by: recordedBy, recorded_by_username: recordedByUsername, recorded_at: recordedAt } = record.data;

  return (
    <main style={pageStyle}>
      <div style={cardStyle}>
        <Link to="/dashboard" id="nav-dashboard-link" style={{ color: '#2563eb', textDecoration: 'none', fontSize: '0.875rem' }}>
          ← กลับไปยังแดชบอร์ด
        </Link>
        <h1 id="repair-detail-heading" style={{ fontSize: '1.5rem', fontWeight: 600, margin: '0.75rem 0 1.5rem 0', color: '#111827' }}>
          {REPAIR_RECORD_LABEL}
        </h1>

        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.75rem 1.5rem', margin: '0 0 1rem 0', fontSize: '0.9375rem', backgroundColor: '#f9fafb', padding: '1.25rem', borderRadius: '6px' }}>
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
          <dt style={termStyle}>ผู้บันทึก:</dt>
          <dd id="repair-recorded-by" style={valueStyle}>
            {recordedByUsername ?? recordedBy}
          </dd>
          <dt style={termStyle}>วันที่บันทึก:</dt>
          <dd id="repair-recorded-at" style={valueStyle}>
            <time dateTime={recordedAt}>{THAI_DATE_TIME.format(new Date(recordedAt))}</time>
          </dd>
        </dl>
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
