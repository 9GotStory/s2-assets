import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { entryLabel } from '../components/ReferenceContextFields';
import { thaiDate } from '../components/assignmentFacts';
import { CONDITION_LABELS, borrowerText, type Loan } from '../components/loanFacts';

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

const LoanDetailContent: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

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

  const { borrower, loan_date: loanDate, authorizer, document_reference: documentReference, remark, recorded_by: recordedBy, recorded_by_username: recordedByUsername, recorded_at: recordedAt, items } = loan.data;

  return (
    <main style={pageStyle}>
      <div style={cardStyle}>
        <Link to="/dashboard" id="nav-dashboard-link" style={{ color: '#2563eb', textDecoration: 'none', fontSize: '0.875rem' }}>
          ← กลับไปยังแดชบอร์ด
        </Link>
        <h1 id="loan-detail-heading" style={{ fontSize: '1.5rem', fontWeight: 600, margin: '0.75rem 0 1.5rem 0', color: '#111827' }}>
          การยืม
        </h1>

        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.75rem 1.5rem', margin: '0 0 2rem 0', fontSize: '0.9375rem', backgroundColor: '#f9fafb', padding: '1.25rem', borderRadius: '6px' }}>
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

        <h2 style={{ fontSize: '1.125rem', fontWeight: 600, marginTop: 0, marginBottom: '1rem', color: '#374151' }}>รายการยืม</h2>
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {items.map((item) => (
            <li key={item.id} data-testid="loan-item" style={{ borderTop: '1px solid #e5e7eb', padding: '0.75rem 0', fontSize: '0.875rem', color: '#374151' }}>
              <Link to={`/assets/${item.asset.id}`} style={{ color: '#2563eb', textDecoration: 'underline', fontWeight: 500 }}>
                {item.asset.name ?? item.asset.asset_number ?? item.asset.id}
              </Link>
              {item.asset.asset_number && item.asset.name && <span style={{ color: '#6b7280' }}> ({item.asset.asset_number})</span>}
              <div>
                กำหนดคืน: <time dateTime={item.due_date}>{thaiDate(item.due_date)}</time>
              </div>
              <div>
                สภาพ: {CONDITION_LABELS[item.condition]}
                {item.condition_note ? ` (${item.condition_note})` : ''}
              </div>
            </li>
          ))}
        </ol>
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
