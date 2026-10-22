import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router';

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
}

export const AssetDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [assetData, setAssetData] = useState<AssetDetailResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    const fetchAssetDetail = async () => {
      try {
        // Verify session first
        const sessionRes = await fetch('/auth/session-check', {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });

        if (!sessionRes.ok) {
          navigate('/login', { replace: true });
          return;
        }

        if (!id) {
          setErrorStatus(400);
          setErrorMessage('ไม่พบรหัสครุภัณฑ์ที่ต้องการเรียกดู');
          setIsLoading(false);
          return;
        }

        const res = await fetch(`/assets/${id}`, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });

        if (res.status === 403) {
          setErrorStatus(403);
          setErrorMessage('คุณไม่มีสิทธิ์เข้าถึงข้อมูลครุภัณฑ์นี้ (403 Forbidden)');
          setIsLoading(false);
          return;
        }

        if (res.status === 404) {
          setErrorStatus(404);
          setErrorMessage('ไม่พบข้อมูลครุภัณฑ์ตามรหัสที่ระบุ');
          setIsLoading(false);
          return;
        }

        if (!res.ok) {
          setErrorStatus(res.status);
          setErrorMessage('เกิดข้อผิดพลาดในการดึงข้อมูลครุภัณฑ์');
          setIsLoading(false);
          return;
        }

        const data: AssetDetailResponse = await res.json();
        setAssetData(data);
        setIsLoading(false);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        setErrorStatus(500);
        setErrorMessage('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์');
        setIsLoading(false);
      }
    };

    fetchAssetDetail();

    return () => {
      controller.abort();
    };
  }, [id, navigate]);

  if (isLoading) {
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

  if (errorStatus || !assetData) {
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
            {errorMessage || 'เกิดข้อผิดพลาด'}
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

        {/* Timeline Starting History */}
        <section aria-labelledby="history-heading">
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
      </div>
    </main>
  );
};

export default AssetDetail;
