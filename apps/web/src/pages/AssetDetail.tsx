import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { AssetCorrectionForm } from '../components/AssetCorrectionForm';

export interface AssetRecord {
  id: string;
  asset_number: string | null;
  serial_number: string | null;
  name: string | null;
  category: string | null;
  organization_unit: string | null;
  source_reference: string | null;
  source_notes: string | null;
  registered_by: string;
  recorded_at: string;
  created_at?: string;
  updated_at?: string;
}

export interface HistoryRecord {
  id: string;
  asset_id: string;
  action: string;
  actor_id: string;
  actor_username?: string;
  recorded_at: string;
  payload: Record<string, unknown> | null;
  created_at?: string;
}

export interface AssetDetailResponse {
  asset: AssetRecord;
  history: HistoryRecord[];
  can_correct?: boolean;
}

export const AssetDetail: React.FC = () => {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            refetchOnWindowFocus: true,
          },
        },
      })
  );

  useEffect(() => {
    return () => {
      queryClient.clear();
    };
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <AssetDetailContent />
    </QueryClientProvider>
  );
};

const AssetDetailContent: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<{ id: string; role?: string } | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [isCorrectionRevoked, setIsCorrectionRevoked] = useState(false);
  const [terminalError, setTerminalError] = useState<string | null>(null);

  const verifySession = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const sessionRes = await fetch('/auth/session-check', {
          method: 'GET',
          credentials: 'include',
          signal,
        });

        if (!sessionRes.ok) {
          queryClient.clear();
          setCurrentUser(null);
          setCsrfToken(null);
          navigate('/login', { replace: true });
          return null;
        }

        const data = await sessionRes.json();
        const user = data.user || null;
        setCurrentUser((prevUser) => {
          if (prevUser && user && prevUser.id !== user.id) {
            queryClient.clear();
          }
          return user;
        });
        setCsrfToken(data.csrfToken || null);
        setSessionLoading(false);
        return user;
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return null;
        }
        queryClient.clear();
        setCurrentUser(null);
        setCsrfToken(null);
        navigate('/login', { replace: true });
        return null;
      }
    },
    [navigate, queryClient]
  );

  useEffect(() => {
    const controller = new AbortController();
    verifySession(controller.signal);

    const handleFocus = () => {
      verifySession();
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleFocus);

    return () => {
      controller.abort();
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleFocus);
    };
  }, [verifySession]);

  const {
    data: assetData,
    isLoading: isAssetLoading,
    error: assetError,
    refetch,
  } = useQuery<AssetDetailResponse, Error & { status?: number }>({
    queryKey: ['asset', currentUser?.id, id],
    queryFn: async ({ signal }) => {
      if (!id) {
        const err = new Error('ไม่พบรหัสครุภัณฑ์ที่ต้องการเรียกดู') as Error & { status?: number };
        err.status = 400;
        throw err;
      }

      const res = await fetch(`/assets/${id}`, {
        method: 'GET',
        credentials: 'include',
        signal,
      });

      if (res.status === 401) {
        navigate('/login', { replace: true });
        const err = new Error('Session expired') as Error & { status?: number };
        err.status = 401;
        setTerminalError('Session expired');
        throw err;
      }

      if (res.status === 403) {
        const err = new Error('คุณไม่มีสิทธิ์เข้าถึงข้อมูลครุภัณฑ์นี้ (403 Forbidden)') as Error & {
          status?: number;
        };
        err.status = 403;
        setTerminalError(err.message);
        throw err;
      }

      if (res.status === 404) {
        const err = new Error('ไม่พบข้อมูลครุภัณฑ์ตามรหัสที่ระบุ') as Error & { status?: number };
        err.status = 404;
        setTerminalError(err.message);
        throw err;
      }

      if (!res.ok) {
        const err = new Error('เกิดข้อผิดพลาดในการดึงข้อมูลครุภัณฑ์') as Error & { status?: number };
        err.status = res.status;
        throw err;
      }

      return res.json();
    },
    enabled: !sessionLoading && !!id,
  });

  useEffect(() => {
    if (
      assetError &&
      (assetError.status === 401 ||
        assetError.status === 403 ||
        assetError.status === 404)
    ) {
      setTerminalError(assetError.message);
      queryClient.setQueryData(['asset', currentUser?.id, id], null);
    }
  }, [assetError, currentUser?.id, id, queryClient]);

  const handlePermissionRevoked = useCallback(async () => {
    setIsCorrectionRevoked(true);
    const survivingUser = await verifySession();
    if (!survivingUser) return;

    // Freshly revalidate asset:view read authorization
    const freshResult = await refetch();
    if (freshResult.isError) {
      // Full view revocation: immediately suppress all protected cached content
      queryClient.clear();
      setTerminalError(freshResult.error?.message || 'คุณไม่มีสิทธิ์เข้าถึงข้อมูลครุภัณฑ์นี้ (403 Forbidden)');
    }
  }, [verifySession, refetch, queryClient]);

  if (
    !assetData ||
    terminalError ||
    (assetError &&
      (assetError.status === 401 ||
        assetError.status === 403 ||
        assetError.status === 404))
  ) {
    if (!terminalError && !assetError && (sessionLoading || isAssetLoading || !assetData)) {
      return (
        <main
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            minHeight: '100vh',
            backgroundColor: '#f5f5f5',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          <div role="status" aria-live="polite" style={{ color: '#4b5563' }}>
            กำลังโหลดข้อมูลครุภัณฑ์...
          </div>
        </main>
      );
    }

    return (
      <main
        style={{
          minHeight: '100vh',
          padding: '2rem',
          backgroundColor: '#f5f5f5',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div
          style={{
            maxWidth: '650px',
            margin: '0 auto',
            backgroundColor: '#ffffff',
            borderRadius: '8px',
            padding: '2rem',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
            textAlign: 'center',
          }}
        >
          <div
            role="alert"
            style={{
              padding: '1rem',
              backgroundColor: '#fee2e2',
              color: '#991b1b',
              borderRadius: '6px',
              marginBottom: '1.5rem',
              fontWeight: 500,
            }}
          >
            {terminalError || assetError?.message || 'เกิดข้อผิดพลาดในการโหลดข้อมูล'}
          </div>
          <Link
            to="/dashboard"
            style={{
              color: '#2563eb',
              textDecoration: 'none',
              fontWeight: 500,
              fontSize: '0.875rem',
            }}
          >
            ← กลับไปยังแดชบอร์ด
          </Link>
        </div>
      </main>
    );
  }

  const { asset, history = [] } = assetData;
  const can_correct = Boolean(assetData.can_correct && !isCorrectionRevoked);
  const registrationFact = history.find((h) => h.action === 'REGISTERED');
  const isLegacy = Boolean(
    registrationFact?.payload &&
      typeof registrationFact.payload === 'object' &&
      (registrationFact.payload as Record<string, unknown>).is_legacy === true
  );

  return (
    <main
      style={{
        minHeight: '100vh',
        padding: '1.5rem',
        boxSizing: 'border-box',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        backgroundColor: '#f5f5f5',
      }}
    >
      <div
        style={{
          maxWidth: '800px',
          margin: '0 auto',
          backgroundColor: '#ffffff',
          borderRadius: '8px',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
          padding: '2rem',
          boxSizing: 'border-box',
        }}
      >
        {/* Navigation & Header */}
        <div
          style={{
            marginBottom: '1.5rem',
            borderBottom: '1px solid #e5e7eb',
            paddingBottom: '1rem',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '0.75rem',
            }}
          >
            <Link
              to="/dashboard"
              style={{
                color: '#2563eb',
                textDecoration: 'none',
                fontSize: '0.875rem',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              ← กลับไปยังแดชบอร์ด
            </Link>
            <Link
              to="/assets/register"
              style={{
                padding: '0.375rem 0.75rem',
                backgroundColor: '#f3f4f6',
                border: '1px solid #d1d5db',
                borderRadius: '4px',
                fontSize: '0.8125rem',
                color: '#374151',
                textDecoration: 'none',
                fontWeight: 500,
              }}
            >
              + ลงทะเบียนครุภัณฑ์เพิ่ม
            </Link>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              flexWrap: 'wrap',
            }}
          >
            <h1
              id="asset-detail-heading"
              style={{
                fontSize: '1.5rem',
                fontWeight: 600,
                margin: 0,
                color: '#111827',
              }}
            >
              {asset.name || '(ไม่ระบุชื่อ - ข้อมูลตกทอดตามจริง)'}
            </h1>
            {isLegacy ? (
              <span
                style={{
                  padding: '0.25rem 0.5rem',
                  backgroundColor: '#fef3c7',
                  color: '#92400e',
                  borderRadius: '4px',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                }}
              >
                ข้อมูลตกทอด (Legacy)
              </span>
            ) : (
              <span
                style={{
                  padding: '0.25rem 0.5rem',
                  backgroundColor: '#ecfdf5',
                  color: '#065f46',
                  borderRadius: '4px',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                }}
              >
                ปกติ
              </span>
            )}
          </div>
          <p
            style={{
              margin: '0.25rem 0 0 0',
              fontSize: '0.875rem',
              color: '#6b7280',
              fontFamily: 'monospace',
            }}
          >
            Stable ID: {asset.id}
          </p>
        </div>

        {/* Core Asset Details */}
        <section
          aria-labelledby="core-info-heading"
          style={{ marginBottom: '2rem' }}
        >
          <h2
            id="core-info-heading"
            style={{
              fontSize: '1.125rem',
              fontWeight: 600,
              marginTop: 0,
              marginBottom: '1rem',
              color: '#374151',
            }}
          >
            ข้อมูลครุภัณฑ์
          </h2>

          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: 'max-content 1fr',
              gap: '0.75rem 1.5rem',
              margin: 0,
              fontSize: '0.9375rem',
              backgroundColor: '#f9fafb',
              padding: '1.25rem',
              borderRadius: '6px',
            }}
          >
            <dt style={{ fontWeight: 500, color: '#4b5563' }}>
              Stable ID (UUID):
            </dt>
            <dd style={{ margin: 0, color: '#111827', fontFamily: 'monospace' }}>
              {asset.id}
            </dd>

            <dt style={{ fontWeight: 500, color: '#4b5563' }}>
              ชื่อ/คำอธิบาย:
            </dt>
            <dd style={{ margin: 0, color: '#111827' }}>
              {asset.name || (
                <span style={{ color: '#9ca3af' }}>
                  ไม่ระบุชื่อ (ข้อมูลตกทอดตามจริง)
                </span>
              )}
            </dd>

            <dt style={{ fontWeight: 500, color: '#4b5563' }}>เลขครุภัณฑ์:</dt>
            <dd style={{ margin: 0, color: '#111827' }}>
              {asset.asset_number || (
                <span style={{ color: '#9ca3af' }}>ไม่มีข้อมูล</span>
              )}
            </dd>

            <dt style={{ fontWeight: 500, color: '#4b5563' }}>
              หมายเลขซีเรียล:
            </dt>
            <dd style={{ margin: 0, color: '#111827' }}>
              {asset.serial_number || (
                <span style={{ color: '#9ca3af' }}>ไม่มีข้อมูล</span>
              )}
            </dd>

            <dt style={{ fontWeight: 500, color: '#4b5563' }}>หมวดหมู่:</dt>
            <dd style={{ margin: 0, color: '#6b7280' }}>
              🏷️ ยังไม่ระบุหมวดหมู่ (Uncategorized)
            </dd>

            <dt style={{ fontWeight: 500, color: '#4b5563' }}>
              เอกสาร / บันทึกที่มา:
            </dt>
            <dd style={{ margin: 0, color: '#111827' }}>
              {asset.source_reference || (
                <span style={{ color: '#9ca3af' }}>ไม่มีข้อมูล</span>
              )}
            </dd>

            <dt style={{ fontWeight: 500, color: '#4b5563' }}>
              วันที่บันทึกลงระบบ:
            </dt>
            <dd style={{ margin: 0, color: '#111827' }}>{asset.recorded_at}</dd>

            <dt style={{ fontWeight: 500, color: '#4b5563' }}>
              ผู้บันทึก (Actor ID):
            </dt>
            <dd
              style={{
                margin: 0,
                color: '#111827',
                fontFamily: 'monospace',
              }}
            >
              {asset.registered_by}
            </dd>
          </dl>
        </section>

        {/* Timeline Starting and Correction History */}
        <section aria-labelledby="history-heading" style={{ marginBottom: '2rem' }}>
          <h2
            id="history-heading"
            style={{
              fontSize: '1.125rem',
              fontWeight: 600,
              marginTop: 0,
              marginBottom: '1rem',
              color: '#374151',
            }}
          >
            ประวัติการดำเนินงาน (Timeline History)
          </h2>

          <div
            style={{
              border: '1px solid #e5e7eb',
              borderRadius: '6px',
              overflow: 'hidden',
            }}
          >
            <table
              style={{
                width: '100%',
                fontSize: '0.875rem',
                borderCollapse: 'collapse',
              }}
            >
              <thead>
                <tr
                  style={{
                    backgroundColor: '#f9fafb',
                    borderBottom: '1px solid #e5e7eb',
                    textAlign: 'left',
                  }}
                >
                  <th style={{ padding: '0.75rem 1rem', color: '#4b5563' }}>
                    เหตุการณ์
                  </th>
                  <th style={{ padding: '0.75rem 1rem', color: '#4b5563' }}>
                    เวลาที่บันทึก
                  </th>
                  <th style={{ padding: '0.75rem 1rem', color: '#4b5563' }}>
                    ผู้ดำเนินงาน (Actor)
                  </th>
                  <th style={{ padding: '0.75rem 1rem', color: '#4b5563' }}>
                    รายละเอียด
                  </th>
                </tr>
              </thead>
              <tbody>
                {history && history.length > 0 ? (
                  history.map((h) => (
                    <tr
                      key={h.id}
                      style={{ borderBottom: '1px solid #f3f4f6' }}
                    >
                      <td
                        style={{
                          padding: '0.75rem 1rem',
                          fontWeight: 600,
                          color: '#111827',
                        }}
                      >
                        {h.action === 'REGISTERED'
                          ? 'ลงทะเบียนครุภัณฑ์ (REGISTERED)'
                          : h.action === 'CORRECTED'
                          ? 'แก้ไขข้อมูลครุภัณฑ์ (CORRECTED)'
                          : h.action}
                      </td>
                      <td
                        style={{
                          padding: '0.75rem 1rem',
                          color: '#4b5563',
                        }}
                      >
                        {h.recorded_at}
                      </td>
                      <td
                        style={{
                          padding: '0.75rem 1rem',
                          fontFamily: 'monospace',
                          color: '#4b5563',
                        }}
                      >
                        {h.actor_id}
                      </td>
                      <td
                        style={{
                          padding: '0.75rem 1rem',
                          color: '#374151',
                        }}
                      >
                        {h.action === 'CORRECTED' &&
                          typeof (h.payload as any)?.reason === 'string' && (
                            <div
                              style={{
                                marginBottom: '0.375rem',
                                fontWeight: 500,
                                color: '#111827',
                              }}
                            >
                              เหตุผล: {(h.payload as any).reason}
                            </div>
                          )}
                        <pre
                          style={{
                            margin: 0,
                            fontFamily: 'monospace',
                            fontSize: '0.75rem',
                            whiteSpace: 'pre-wrap',
                            maxHeight: '100px',
                            overflowY: 'auto',
                            backgroundColor: '#f3f4f6',
                            padding: '0.375rem 0.5rem',
                            borderRadius: '4px',
                          }}
                        >
                          {JSON.stringify(h.payload, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td
                      colSpan={4}
                      style={{
                        padding: '1rem',
                        textAlign: 'center',
                        color: '#9ca3af',
                      }}
                    >
                      ไม่มีประวัติการดำเนินงาน
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {refreshError && (
          <div
            role="alert"
            data-testid="refresh-error-banner"
            style={{
              padding: '1rem',
              backgroundColor: '#fef3c7',
              border: '1px solid #f59e0b',
              borderRadius: '6px',
              color: '#92400e',
              marginBottom: '1.5rem',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>{refreshError}</span>
            <button
              type="button"
              id="retry-refresh-btn"
              onClick={async () => {
                const res = await refetch();
                if (!res.isError) {
                  setRefreshError(null);
                } else if (res.error?.status === 403 || res.error?.status === 401) {
                  // Revocation during refresh recovery fails closed!
                  queryClient.clear();
                  setTerminalError(res.error.message || 'คุณไม่มีสิทธิ์เข้าถึงข้อมูลครุภัณฑ์นี้ (403 Forbidden)');
                }
              }}
              style={{
                marginLeft: '1rem',
                padding: '0.375rem 0.75rem',
                backgroundColor: '#b45309',
                color: '#ffffff',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '0.875rem',
              }}
            >
              โหลดข้อมูลใหม่ (Retry)
            </button>
          </div>
        )}

        {/* Correction Section (Rendered for Authorized Roles; Read-only notice otherwise) */}
        {can_correct ? (
          <section aria-labelledby="correction-heading">
            <AssetCorrectionForm
              asset={asset}
              isLegacy={isLegacy}
              csrfToken={csrfToken}
              onPermissionRevoked={handlePermissionRevoked}
              onSuccess={async () => {
                setRefreshError(null);
                const refetchResult = await refetch();
                if (refetchResult.isError) {
                  setRefreshError(
                    'บันทึกการแก้ไขครุภัณฑ์สำเร็จ แต่การดึงข้อมูลล่าสุดล้มเหลว กรุณากดปุ่มเพื่อโหลดข้อมูลใหม่'
                  );
                  return false;
                }
                return true;
              }}
            />
          </section>
        ) : (
          <div
            data-testid="read-only-notice"
            style={{
              padding: '0.75rem 1rem',
              backgroundColor: '#f3f4f6',
              border: '1px solid #e5e7eb',
              borderRadius: '6px',
              color: '#6b7280',
              fontSize: '0.875rem',
              textAlign: 'center',
            }}
          >
            ผู้ใช้ปัจจุบันมีสิทธิ์อ่านอย่างเดียว ไม่สามารถแก้ไขข้อมูลครุภัณฑ์ได้
          </div>
        )}
      </div>
    </main>
  );
};

export default AssetDetail;
