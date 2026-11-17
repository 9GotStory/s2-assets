import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useReferenceLists } from '../components/ReferenceContextFields';
import { VerificationRoundOpenForm } from '../components/VerificationRoundOpenForm';
import { thaiDate } from '../components/assignmentFacts';
import {
  FISCAL_YEAR_LABEL,
  OPEN_VERIFICATION_ROUND_LABEL,
  RESULT_LABELS,
  ROUND_STATE_LABELS,
  SCOPE_SNAPSHOT_LABEL,
  START_DATE_LABEL,
  VERIFICATION_ROUND_LABEL,
  type VerificationRoundList as RoundList,
} from '../components/verificationFacts';

const LOAD_ERRORS: Record<number, string> = {
  403: 'คุณไม่มีสิทธิ์เข้าถึงรอบตรวจ (403 Forbidden)',
};

const cellStyle: React.CSSProperties = { padding: '0.75rem 1rem', color: '#111827', verticalAlign: 'top' };
const headStyle: React.CSSProperties = { padding: '0.75rem 1rem', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' };

const VerificationRoundListContent: React.FC = () => {
  const navigate = useNavigate();
  const [isOpening, setIsOpening] = useState(false);

  const rounds = useQuery<RoundList, Error & { status?: number }>({
    queryKey: ['verification-rounds'],
    queryFn: async ({ signal }) => {
      const res = await fetch('/verification-rounds', { credentials: 'include', signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
  });

  // The open form needs this session's CSRF token, and the Reference Lists it filters by.
  const canManage = rounds.data?.can_manage_verification === true && !rounds.isError;
  const session = useQuery<{ csrfToken: string | null; userId: string | null } | null>({
    queryKey: ['verification-session'],
    queryFn: async ({ signal }) => {
      const res = await fetch('/auth/session-check', { credentials: 'include', signal });
      if (!res.ok) {
        return null;
      }
      const body = await res.json();
      return { csrfToken: body.csrfToken ?? null, userId: body.user?.id ?? null };
    },
    enabled: canManage,
  });
  // The action waits for the token: a request sent without it is refused as if the grant were gone.
  const csrfToken = session.data?.csrfToken ?? null;
  const mayOpen = canManage && csrfToken !== null;
  const { lists, error: listsError } = useReferenceLists(false, isOpening ? (session.data?.userId ?? null) : null);

  const isSignedOut = rounds.error?.status === 401;
  useEffect(() => {
    if (isSignedOut) {
      navigate('/login', { replace: true });
    }
  }, [isSignedOut, navigate]);

  // A failed read hides what an earlier one showed: a lost grant fails closed.
  const list = rounds.isError ? undefined : rounds.data;
  const isForbidden = rounds.error?.status === 403;

  return (
    <main style={{ minHeight: '100vh', backgroundColor: '#f3f4f6', padding: '1rem', fontFamily: 'system-ui, -apple-system, sans-serif', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: '1000px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1)', padding: '1.25rem', boxSizing: 'border-box' }}>
        <Link to="/dashboard" id="back-dashboard-link" style={{ color: '#4b5563', textDecoration: 'none', fontSize: '0.875rem', fontWeight: 500 }}>
          ← กลับสู่แดชบอร์ด
        </Link>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: '1rem 0 1.5rem 0' }}>{VERIFICATION_ROUND_LABEL}</h1>

        {rounds.isError && !isSignedOut && (
          <div role="alert" id="verification-round-list-error" style={{ padding: '0.75rem 1rem', marginBottom: '1.5rem', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
            {LOAD_ERRORS[rounds.error.status ?? 0] ?? 'เกิดข้อผิดพลาดในการโหลดรอบตรวจ'}{' '}
            {!isForbidden && (
              <button type="button" id="verification-round-list-retry" onClick={() => rounds.refetch()}>
                ลองใหม่
              </button>
            )}
          </div>
        )}

        {rounds.isPending && (
          <div role="status" aria-busy="true" style={{ padding: '2rem', textAlign: 'center', color: '#6b7280', fontSize: '0.875rem' }}>
            กำลังโหลดรอบตรวจ...
          </div>
        )}

        {list && (
          <>
            {mayOpen && !isOpening && (
              <button
                type="button"
                id="verification-open-action"
                onClick={() => setIsOpening(true)}
                style={{ padding: '0.5rem 1.25rem', marginBottom: '1.5rem', backgroundColor: '#2563eb', color: '#ffffff', border: 'none', borderRadius: '6px', fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer' }}
              >
                {OPEN_VERIFICATION_ROUND_LABEL}
              </button>
            )}
            {mayOpen && isOpening && (
              <VerificationRoundOpenForm
                lists={lists}
                listsError={listsError}
                csrfToken={csrfToken}
                onOpened={async () => {
                  setIsOpening(false);
                  await rounds.refetch();
                }}
                onCancel={() => setIsOpening(false)}
                onPermissionRevoked={(status) => {
                  if (status === 401) {
                    navigate('/login', { replace: true });
                    return;
                  }
                  void rounds.refetch();
                }}
              />
            )}

            <section aria-label={VERIFICATION_ROUND_LABEL} id="verification-round-list-region">
              {list.items.length === 0 ? (
                <div
                  id="verification-round-list-empty"
                  style={{ padding: '3rem 1rem', textAlign: 'center', backgroundColor: '#f9fafb', borderRadius: '6px', border: '1px dashed #d1d5db', color: '#6b7280', fontSize: '0.9375rem' }}
                >
                  ยังไม่มีรอบตรวจ
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table id="verification-round-list-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.875rem' }}>
                    <thead>
                      <tr style={{ backgroundColor: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                        <th style={headStyle}>{VERIFICATION_ROUND_LABEL}</th>
                        <th style={headStyle}>{FISCAL_YEAR_LABEL}</th>
                        <th style={headStyle}>{START_DATE_LABEL}</th>
                        <th style={headStyle}>สถานะ</th>
                        <th style={headStyle}>{SCOPE_SNAPSHOT_LABEL}</th>
                        <th style={headStyle}>{RESULT_LABELS.NOT_YET_VERIFIED}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.items.map((round) => (
                        <tr key={round.id} data-testid={`verification-round-row-${round.id}`} style={{ borderBottom: '1px solid #e5e7eb' }}>
                          <td style={{ ...cellStyle, fontWeight: 500 }}>
                            <Link to={`/verification-rounds/${round.id}`} style={{ color: '#2563eb', textDecoration: 'underline' }}>
                              {round.name}
                            </Link>
                          </td>
                          <td style={cellStyle}>{round.fiscal_year}</td>
                          <td style={cellStyle}>
                            <time dateTime={round.start_date}>{thaiDate(round.start_date)}</time>
                          </td>
                          <td style={cellStyle} data-testid={`verification-round-state-${round.id}`}>
                            {ROUND_STATE_LABELS[round.state]}
                          </td>
                          <td style={cellStyle}>{round.counts.in_scope}</td>
                          <td style={cellStyle}>{round.counts.not_yet_verified}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
};

/** The Round list ("รอบตรวจ", F006-T1): every Verification Round, newest first, and "เปิดรอบตรวจ" for holders. */
export const VerificationRoundList: React.FC = () => {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } }));

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <VerificationRoundListContent />
    </QueryClientProvider>
  );
};
