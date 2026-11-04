import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import { EvidencePanel } from '../components/EvidencePanel';

export interface LinkedAsset {
  id: string;
  asset_number: string | null;
  serial_number: string | null;
  name: string | null;
  recorded_at: string;
}

export interface AcquisitionDetailData {
  id: string;
  acquisition_type: string | null;
  acquisition_date: string | null;
  total_amount: string | null;
  currency: string | null;
  source_reference: string | null;
  notes: string | null;
  recorded_at: string;
  created_by: string;
  assets?: LinkedAsset[];
  total_assets?: number;
  has_more?: boolean;
  limit?: number;
  offset?: number;
}

export const AcquisitionDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [acquisition, setAcquisition] = useState<AcquisitionDetailData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<{ id: string; role?: string } | null>(null);
  const limit = 25;

  const isMountedRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);
  const reqGenRef = useRef(0);
  const offsetRef = useRef(0);
  const acquisitionRef = useRef<AcquisitionDetailData | null>(null);
  acquisitionRef.current = acquisition;

  const fetchAcquisition = useCallback(
    async (currentOffset: number = 0) => {
      if (!id) return;

      // Abort any ongoing fetch
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const currentGen = ++reqGenRef.current;

      setIsLoading(true);
      setErrorStatus(null);
      setErrorMessage(null);

      try {
        const response = await fetch(
          `/acquisitions/${id}?includeAssets=true&limit=${limit}&offset=${currentOffset}`,
          {
            method: 'GET',
            credentials: 'include',
            signal: controller.signal,
          }
        );

        if (!isMountedRef.current || currentGen !== reqGenRef.current) return;

        if (response.status === 401) {
          setAcquisition(null);
          navigate('/login', { replace: true });
          return;
        }

        if (response.status === 403) {
          setAcquisition(null);
          setErrorStatus(403);
          setErrorMessage('คุณไม่มีสิทธิ์เข้าถึงข้อมูลการได้มานี้ (403 Forbidden)');
          setIsLoading(false);
          return;
        }

        if (response.status === 404) {
          setAcquisition(null);
          setErrorStatus(404);
          setErrorMessage('ไม่พบข้อมูลการได้มาที่ระบุ (404 Not Found)');
          setIsLoading(false);
          return;
        }

        if (!response.ok) {
          setErrorStatus(response.status);
          setErrorMessage('เกิดข้อผิดพลาดในการโหลดข้อมูลการได้มา');
          setIsLoading(false);
          return;
        }

        const data: AcquisitionDetailData = await response.json();
        if (!isMountedRef.current || currentGen !== reqGenRef.current) return;

        setAcquisition(data);
        setOffset(currentOffset);
        offsetRef.current = currentOffset;
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        if (!isMountedRef.current || currentGen !== reqGenRef.current) return;
        setErrorStatus(500);
        setErrorMessage('เกิดข้อผิดพลาดในการเชื่อมต่อเครือข่าย');
      } finally {
        if (isMountedRef.current && currentGen === reqGenRef.current) {
          setIsLoading(false);
        }
      }
    },
    [id, navigate]
  );

  const sessionAbortRef = useRef<AbortController | null>(null);
  const sessionGenRef = useRef(0);

  const checkSession = useCallback(async () => {
    if (sessionAbortRef.current) {
      sessionAbortRef.current.abort();
    }
    const controller = new AbortController();
    sessionAbortRef.current = controller;
    const currentGen = ++sessionGenRef.current;

    try {
      const res = await fetch('/auth/session-check', {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal,
      });

      if (!isMountedRef.current || currentGen !== sessionGenRef.current || controller.signal.aborted) {
        return;
      }

      if (!res.ok) {
        setCurrentUser(null);
        setCsrfToken(null);
        navigate('/login', { replace: true });
        return;
      }

      const data = await res.json();
      if (!isMountedRef.current || currentGen !== sessionGenRef.current || controller.signal.aborted) {
        return;
      }

      const user = data.user || null;
      if (!user) {
        setCurrentUser(null);
        setCsrfToken(null);
        navigate('/login', { replace: true });
        return;
      }

      setCurrentUser(user);
      setCsrfToken(data.csrfToken || null);
    } catch (err: unknown) {
      if (!isMountedRef.current || currentGen !== sessionGenRef.current || controller.signal.aborted) {
        return;
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      setCurrentUser(null);
      setCsrfToken(null);
    }
  }, [navigate]);

  useEffect(() => {
    isMountedRef.current = true;
    fetchAcquisition(0);
    checkSession();

    const handleFocusRevalidate = () => {
      if (document.visibilityState === 'visible' && isMountedRef.current) {
        checkSession();
        fetchAcquisition(offsetRef.current);
      }
    };

    window.addEventListener('focus', handleFocusRevalidate);
    document.addEventListener('visibilitychange', handleFocusRevalidate);

    return () => {
      isMountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (sessionAbortRef.current) {
        sessionAbortRef.current.abort();
      }
      window.removeEventListener('focus', handleFocusRevalidate);
      document.removeEventListener('visibilitychange', handleFocusRevalidate);
    };
  }, [fetchAcquisition, checkSession]);

  if (isLoading && !acquisition) {
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
          กำลังโหลดข้อมูลการได้มา...
        </div>
      </main>
    );
  }

  if (errorStatus || !acquisition) {
    return (
      <main
        style={{
          minHeight: '100vh',
          padding: '2rem 1rem',
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
            id="acquisition-error-alert"
            style={{
              padding: '1rem',
              borderRadius: '6px',
              backgroundColor: '#fee2e2',
              border: '1px solid #ef4444',
              color: '#991b1b',
              marginBottom: '1.5rem',
            }}
          >
            <p style={{ margin: 0, fontWeight: 500 }}>
              {errorMessage || 'ไม่สามารถแสดงข้อมูลการได้มาได้'}
            </p>
          </div>
          <Link
            to="/dashboard"
            style={{
              color: '#2563eb',
              textDecoration: 'underline',
              fontSize: '0.875rem',
            }}
          >
            ← กลับสู่แดชบอร์ด
          </Link>
        </div>
      </main>
    );
  }

  const assets = acquisition.assets || [];
  const totalAssets = acquisition.total_assets ?? assets.length;
  const hasMore = Boolean(acquisition.has_more);

  return (
    <main
      style={{
        minHeight: '100vh',
        padding: '2rem 1rem',
        backgroundColor: '#f5f5f5',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <div
        style={{
          maxWidth: '900px',
          margin: '0 auto',
          backgroundColor: '#ffffff',
          borderRadius: '8px',
          padding: '2rem',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
        }}
      >
        <header style={{ marginBottom: '1.5rem' }}>
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
              id="back-dashboard-link"
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
              to={`/assets/register?acquisition_id=${acquisition.id}`}
              id="register-linked-asset-btn"
              style={{
                padding: '0.375rem 0.75rem',
                backgroundColor: '#2563eb',
                borderRadius: '4px',
                fontSize: '0.8125rem',
                color: '#ffffff',
                textDecoration: 'none',
                fontWeight: 500,
              }}
            >
              + ลงทะเบียนครุภัณฑ์เชื่อมโยงกับการได้มานี้
            </Link>
            <Link
              to={`/assets/bulk-register?acquisition_id=${acquisition.id}`}
              id="bulk-register-linked-asset-btn"
              style={{
                padding: '0.375rem 0.75rem',
                backgroundColor: '#1d4ed8',
                borderRadius: '4px',
                fontSize: '0.8125rem',
                color: '#ffffff',
                textDecoration: 'none',
                fontWeight: 500,
              }}
            >
              + ลงทะเบียนแบบกลุ่มเชื่อมโยงกับการได้มานี้ (Bulk)
            </Link>
          </div>

          <h1
            id="acquisition-detail-heading"
            style={{
              fontSize: '1.5rem',
              fontWeight: 600,
              margin: '0 0 0.5rem 0',
              color: '#111827',
            }}
          >
            ข้อมูลการได้มา (Acquisition Reference)
          </h1>
        </header>

        {/* Whole-Acquisition Total Warning Banner */}
        {!isLoading && acquisition.total_amount && (
          <div
            role="note"
            id="whole-total-warning"
            style={{
              padding: '0.875rem 1rem',
              backgroundColor: '#eff6ff',
              border: '1px solid #bfdbfe',
              borderRadius: '6px',
              color: '#1e40af',
              fontSize: '0.875rem',
              marginBottom: '1.5rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <span style={{ fontSize: '1.25rem' }}>ℹ️</span>
            <div>
              <strong>คำเตือนเรื่องมูลค่ารวม:</strong> มูลค่า{' '}
              {acquisition.total_amount} {acquisition.currency || 'THB'} นี้เป็น{' '}
              <strong>ยอดรวมของการได้มาทั้งชุด (Whole-Acquisition Total)</strong>{' '}
              ไม่ใช่ราคาต่อชิ้นของครุภัณฑ์แต่ละรายการที่เชื่อมโยง
            </div>
          </div>
        )}

        {isLoading && (
          <div
            role="status"
            aria-live="polite"
            style={{
              padding: '1.5rem',
              backgroundColor: '#f9fafb',
              borderRadius: '6px',
              textAlign: 'center',
              color: '#4b5563',
              marginBottom: '2rem',
              fontSize: '0.875rem',
            }}
          >
            กำลังตรวจสอบสิทธิ์และอัปเดตข้อมูล...
          </div>
        )}

        {/* Facts Summary */}
        {!isLoading && (
          <section
            aria-labelledby="acquisition-facts-heading"
            style={{
              backgroundColor: '#f9fafb',
              borderRadius: '6px',
              padding: '1.25rem',
              marginBottom: '2rem',
            }}
          >
            <h2
              id="acquisition-facts-heading"
              style={{
                fontSize: '1.125rem',
                fontWeight: 600,
                marginTop: 0,
                marginBottom: '1rem',
                color: '#374151',
              }}
            >
              รายละเอียดการได้มา
            </h2>

            <dl
              style={{
                display: 'grid',
                gridTemplateColumns: 'max-content 1fr',
                gap: '0.75rem 1.5rem',
                margin: 0,
                fontSize: '0.9375rem',
              }}
            >
              <dt style={{ fontWeight: 500, color: '#4b5563' }}>Acquisition ID (UUID):</dt>
              <dd style={{ margin: 0, color: '#111827', fontFamily: 'monospace' }} id="fact-id">
                {acquisition.id}
              </dd>

              <dt style={{ fontWeight: 500, color: '#4b5563' }}>ประเภทการได้มา:</dt>
              <dd style={{ margin: 0, color: '#111827' }} id="fact-type">
                {acquisition.acquisition_type || (
                  <span style={{ color: '#9ca3af' }}>ไม่มีข้อมูล</span>
                )}
              </dd>

              <dt style={{ fontWeight: 500, color: '#4b5563' }}>วันที่ได้มา:</dt>
              <dd style={{ margin: 0, color: '#111827' }} id="fact-date">
                {acquisition.acquisition_date || (
                  <span style={{ color: '#9ca3af' }}>ไม่มีข้อมูล</span>
                )}
              </dd>

              <dt style={{ fontWeight: 500, color: '#4b5563' }}>มูลค่ารวมทั้งชุด:</dt>
              <dd style={{ margin: 0, color: '#111827' }} id="fact-amount">
                {acquisition.total_amount ? (
                  `${acquisition.total_amount} ${acquisition.currency || 'THB'}`
                ) : (
                  <span style={{ color: '#9ca3af' }}>ไม่มีข้อมูล</span>
                )}
              </dd>

              <dt style={{ fontWeight: 500, color: '#4b5563' }}>เอกสาร / สัญญาอ้างอิง:</dt>
              <dd style={{ margin: 0, color: '#111827' }} id="fact-reference">
                {acquisition.source_reference || (
                  <span style={{ color: '#9ca3af' }}>ไม่มีข้อมูล</span>
                )}
              </dd>

              <dt style={{ fontWeight: 500, color: '#4b5563' }}>หมายเหตุ:</dt>
              <dd style={{ margin: 0, color: '#111827' }} id="fact-notes">
                {acquisition.notes || (
                  <span style={{ color: '#9ca3af' }}>ไม่มีข้อมูล</span>
                )}
              </dd>

              <dt style={{ fontWeight: 500, color: '#4b5563' }}>วันที่บันทึก:</dt>
              <dd style={{ margin: 0, color: '#111827' }} id="fact-recorded-at">
                {acquisition.recorded_at}
              </dd>

              <dt style={{ fontWeight: 500, color: '#4b5563' }}>ผู้บันทึก (Actor ID):</dt>
              <dd style={{ margin: 0, color: '#111827', fontFamily: 'monospace' }} id="fact-created-by">
                {acquisition.created_by}
              </dd>
            </dl>
          </section>
        )}

        {/* Linked Assets List */}
        {!isLoading && (
          <section aria-labelledby="linked-assets-heading">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '1rem',
            }}
          >
            <h2
              id="linked-assets-heading"
              style={{
                fontSize: '1.125rem',
                fontWeight: 600,
                margin: 0,
                color: '#374151',
              }}
            >
              ครุภัณฑ์ที่เชื่อมโยง ({totalAssets} รายการ)
            </h2>
          </div>

          {assets.length === 0 ? (
            <div
              id="no-linked-assets-notice"
              style={{
                padding: '2rem',
                textAlign: 'center',
                backgroundColor: '#f9fafb',
                borderRadius: '6px',
                color: '#6b7280',
                fontSize: '0.875rem',
              }}
            >
              ยังไม่มีครุภัณฑ์เชื่อมโยงกับการได้มานี้
            </div>
          ) : (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table
                  id="linked-assets-table"
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: '0.875rem',
                    textAlign: 'left',
                  }}
                >
                  <thead>
                    <tr style={{ backgroundColor: '#f3f4f6', borderBottom: '1px solid #e5e7eb' }}>
                      <th style={{ padding: '0.75rem', color: '#374151', fontWeight: 600 }}>
                        เลขครุภัณฑ์
                      </th>
                      <th style={{ padding: '0.75rem', color: '#374151', fontWeight: 600 }}>
                        หมายเลขซีเรียล
                      </th>
                      <th style={{ padding: '0.75rem', color: '#374151', fontWeight: 600 }}>
                        ชื่อ / คำอธิบาย
                      </th>
                      <th style={{ padding: '0.75rem', color: '#374151', fontWeight: 600 }}>
                        วันที่บันทึก
                      </th>
                      <th style={{ padding: '0.75rem', color: '#374151', fontWeight: 600 }}>
                        การกระทำ
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {assets.map((item) => (
                      <tr
                        key={item.id}
                        style={{ borderBottom: '1px solid #f3f4f6' }}
                      >
                        <td style={{ padding: '0.75rem', color: '#111827' }}>
                          {item.asset_number || (
                            <span style={{ color: '#9ca3af' }}>-</span>
                          )}
                        </td>
                        <td style={{ padding: '0.75rem', color: '#111827' }}>
                          {item.serial_number || (
                            <span style={{ color: '#9ca3af' }}>-</span>
                          )}
                        </td>
                        <td style={{ padding: '0.75rem', color: '#111827' }}>
                          {item.name || (
                            <span style={{ color: '#9ca3af' }}>ไม่ระบุชื่อ</span>
                          )}
                        </td>
                        <td style={{ padding: '0.75rem', color: '#6b7280' }}>
                          {item.recorded_at}
                        </td>
                        <td style={{ padding: '0.75rem' }}>
                          <Link
                            to={`/assets/${item.id}`}
                            style={{
                              color: '#2563eb',
                              textDecoration: 'underline',
                              fontSize: '0.8125rem',
                            }}
                          >
                            ดูรายละเอียด →
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination controls */}
              {(hasMore || offset > 0) && (
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginTop: '1rem',
                  }}
                >
                  <button
                    disabled={offset <= 0 || isLoading}
                    onClick={() => fetchAcquisition(Math.max(0, offset - limit))}
                    style={{
                      padding: '0.375rem 0.75rem',
                      border: '1px solid #d1d5db',
                      borderRadius: '4px',
                      backgroundColor: offset <= 0 ? '#f3f4f6' : '#ffffff',
                      color: offset <= 0 ? '#9ca3af' : '#374151',
                      cursor: offset <= 0 ? 'not-allowed' : 'pointer',
                      fontSize: '0.8125rem',
                    }}
                  >
                    ← ก่อนหน้า
                  </button>
                  <span style={{ fontSize: '0.8125rem', color: '#6b7280' }}>
                    แสดง {offset + 1} - {Math.min(offset + limit, totalAssets)} จาก {totalAssets}
                  </span>
                  <button
                    disabled={!hasMore || isLoading}
                    onClick={() => fetchAcquisition(offset + limit)}
                    style={{
                      padding: '0.375rem 0.75rem',
                      border: '1px solid #d1d5db',
                      borderRadius: '4px',
                      backgroundColor: !hasMore ? '#f3f4f6' : '#ffffff',
                      color: !hasMore ? '#9ca3af' : '#374151',
                      cursor: !hasMore ? 'not-allowed' : 'pointer',
                      fontSize: '0.8125rem',
                    }}
                  >
                    ถัดไป →
                  </button>
                </div>
              )}
            </>
          )}
          </section>
        )}

        {/* Evidence & References (T7) */}
        <EvidencePanel
          entityType="acquisition"
          entityId={acquisition.id}
          csrfToken={csrfToken}
          currentUser={currentUser}
          isReauthorizing={isLoading}
        />
      </div>
    </main>
  );
};
