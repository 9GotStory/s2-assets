import React, { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router';

export interface DuplicateCandidate {
  id: string;
  name: string | null;
  asset_number: string | null;
  serial_number: string | null;
  recorded_at: string;
}

export interface RegisterAssetResponse {
  asset: {
    id: string;
    name: string | null;
    asset_number: string | null;
    serial_number: string | null;
    category: string | null;
    organization_unit: string | null;
    source_reference: string | null;
    source_notes: string | null;
    registered_by: string;
    recorded_at: string;
  };
  history: {
    id: string;
    asset_id: string;
    action: string;
    actor_id: string;
    recorded_at: string;
    payload: Record<string, unknown> | null;
  };
}

export const AssetRegister: React.FC = () => {
  const [name, setName] = useState('');
  const [assetNumber, setAssetNumber] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [sourceReference, setSourceReference] = useState('');
  const [isLegacy, setIsLegacy] = useState(false);
  const [explicitContinuation, setExplicitContinuation] = useState(false);

  // Maintain persistent retry token across retries for the same registration intent (Spec Finding 5)
  const [retryToken] = useState(() => crypto.randomUUID());

  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [isLoadingSession, setIsLoadingSession] = useState(true);
  const [isCheckingDuplicates, setIsCheckingDuplicates] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [candidates, setCandidates] = useState<DuplicateCandidate[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isForbidden, setIsForbidden] = useState(false);

  const navigate = useNavigate();

  useEffect(() => {
    const controller = new AbortController();

    const verifySession = async () => {
      try {
        const response = await fetch('/auth/session-check', {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });

        if (!response.ok) {
          navigate('/login', { replace: true });
          return;
        }

        const data = await response.json();
        setCsrfToken(data.csrfToken || null);
        setIsLoadingSession(false);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        navigate('/login', { replace: true });
      }
    };

    verifySession();

    return () => {
      controller.abort();
    };
  }, [navigate]);

  const handleCheckDuplicates = async () => {
    if (!assetNumber && !serialNumber) {
      setCandidates([]);
      return;
    }

    setIsCheckingDuplicates(true);
    setErrorMessage(null);

    try {
      const params = new URLSearchParams();
      if (assetNumber) params.append('asset_number', assetNumber);
      if (serialNumber) params.append('serial_number', serialNumber);

      const response = await fetch(
        `/assets/duplicate-candidates?${params.toString()}`,
        {
          method: 'GET',
          credentials: 'include',
        }
      );

      if (response.status === 403) {
        setIsForbidden(true);
        setErrorMessage('คุณไม่มีสิทธิ์ตรวจสอบข้อมูลซ้ำ (403 Forbidden)');
        return;
      }

      if (!response.ok) {
        setErrorMessage('ไม่สามารถตรวจสอบข้อมูลซ้ำได้');
        return;
      }

      const data = await response.json();
      setCandidates(data.candidates || []);
      if (!data.candidates || data.candidates.length === 0) {
        setExplicitContinuation(false);
      }
    } catch {
      setErrorMessage('เกิดข้อผิดพลาดในการเชื่อมต่อเพื่อตรวจสอบข้อมูลซ้ำ');
    } finally {
      setIsCheckingDuplicates(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (isSubmitting) return;

    const trimmedName = name.trim();
    if (!isLegacy && !trimmedName) {
      setErrorMessage(
        'กรุณาระบุชื่อหรือคำอธิบายครุภัณฑ์ (หรือเลือกข้อมูลตกทอดหากเป็นข้อมูลเก่าที่ไม่ทราบชื่อ)'
      );
      return;
    }

    if (candidates.length > 0 && !explicitContinuation) {
      setErrorMessage(
        'พบข้อมูลซ้ำในระบบ โปรดตรวจสอบและยืนยันการลงทะเบียนเป็นครุภัณฑ์ชิ้นใหม่ต่างหากก่อนดำเนินการ'
      );
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (csrfToken) {
        headers['x-csrf-token'] = csrfToken;
      }

      // Aligned API payload (Spec Findings 1, 6, 7, 8)
      const bodyPayload = {
        name: trimmedName || null,
        asset_number: assetNumber ? assetNumber : null,
        serial_number: serialNumber ? serialNumber : null,
        source_reference: sourceReference.trim() ? sourceReference.trim() : null,
        is_legacy: isLegacy,
        explicit_continuation: explicitContinuation,
        retry_token: retryToken,
      };

      const response = await fetch('/assets', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(bodyPayload),
      });

      if (response.status === 403) {
        setIsForbidden(true);
        setErrorMessage('คุณไม่มีสิทธิ์ลงทะเบียนครุภัณฑ์ (403 Forbidden)');
        return;
      }

      if (response.status === 409) {
        const errorData = await response.json().catch(() => null);
        if (
          errorData?.code === 'DUPLICATE_CANDIDATES_FOUND' &&
          Array.isArray(errorData.candidates)
        ) {
          setCandidates(errorData.candidates);
          setErrorMessage(
            'พบครุภัณฑ์ที่มีเลขระบุตัวตนตรงกับในระบบ โปรดยืนยันการลงทะเบียนเป็นชิ้นใหม่หากประสงค์จะดำเนินการต่อ'
          );
        } else {
          setErrorMessage('เกิดข้อขัดแย้งในการลงทะเบียนครุภัณฑ์');
        }
        return;
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        setErrorMessage(
          errorData?.message || 'ไม่สามารถลงทะเบียนครุภัณฑ์ได้ กรุณาตรวจสอบข้อมูล'
        );
        return;
      }

      const result: RegisterAssetResponse = await response.json();
      if (result?.asset?.id) {
        // Direct navigation to the newly created Asset detail page
        navigate(`/assets/${result.asset.id}`);
      }
    } catch {
      setErrorMessage('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์ กรุณาลองใหม่อีกครั้ง');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoadingSession) {
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
          กำลังตรวจสอบสิทธิ์การเข้าใช้งาน...
        </div>
      </main>
    );
  }

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
          maxWidth: '750px',
          margin: '0 auto',
          backgroundColor: '#ffffff',
          borderRadius: '8px',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
          padding: '2rem',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ marginBottom: '1.5rem' }}>
          <Link
            to="/dashboard"
            style={{
              color: '#2563eb',
              textDecoration: 'none',
              fontSize: '0.875rem',
              display: 'inline-flex',
              alignItems: 'center',
              marginBottom: '0.75rem',
            }}
          >
            ← กลับไปยังแดชบอร์ด
          </Link>
          <h1
            style={{
              fontSize: '1.5rem',
              fontWeight: 600,
              margin: '0 0 0.25rem 0',
              color: '#111827',
            }}
          >
            ลงทะเบียนครุภัณฑ์
          </h1>
          <p style={{ margin: 0, fontSize: '0.875rem', color: '#6b7280' }}>
            บันทึกข้อมูลครุภัณฑ์รายชิ้นเข้าสู่ระบบทะเบียนทรัพย์สิน
          </p>
        </div>

        {errorMessage && (
          <div
            role="alert"
            aria-live="polite"
            style={{
              padding: '0.875rem 1rem',
              marginBottom: '1.5rem',
              borderRadius: '6px',
              backgroundColor: '#fee2e2',
              border: '1px solid #ef4444',
              color: '#991b1b',
              fontSize: '0.875rem',
            }}
          >
            {errorMessage}
          </div>
        )}

        {isForbidden && (
          <div
            style={{
              padding: '1.5rem',
              backgroundColor: '#fef2f2',
              borderRadius: '6px',
              border: '1px solid #f87171',
              textAlign: 'center',
              color: '#991b1b',
            }}
          >
            <p style={{ fontWeight: 600, margin: '0 0 0.5rem 0' }}>
              ไม่ได้รับอนุญาต (403 Forbidden)
            </p>
            <p style={{ margin: 0, fontSize: '0.875rem' }}>
              บัญชีผู้ใช้งานของคุณไม่มีสิทธิ์ในการลงทะเบียนครุภัณฑ์หรือตรวจสอบข้อมูลซ้ำ
            </p>
          </div>
        )}

        {!isForbidden && (
          <form onSubmit={handleSubmit} noValidate>
            {/* Legacy Checkbox */}
            <div
              style={{
                padding: '1rem',
                backgroundColor: '#f9fafb',
                borderRadius: '6px',
                border: '1px solid #e5e7eb',
                marginBottom: '1.5rem',
              }}
            >
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  cursor: 'pointer',
                  gap: '0.75rem',
                }}
              >
                <input
                  type="checkbox"
                  id="is_legacy"
                  checked={isLegacy}
                  onChange={(e) => {
                    setIsLegacy(e.target.checked);
                    if (e.target.checked) {
                      setErrorMessage(null);
                    }
                  }}
                  style={{ marginTop: '0.25rem', width: '1rem', height: '1rem' }}
                />
                <div>
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: '0.9375rem',
                      color: '#111827',
                    }}
                  >
                    ข้อมูลตกทอด / ประวัติเดิมที่ข้อมูลไม่สมบูรณ์ (Legacy /
                    Incomplete data)
                  </span>
                  <p
                    style={{
                      margin: '0.25rem 0 0 0',
                      fontSize: '0.8125rem',
                      color: '#6b7280',
                    }}
                  >
                    เลือกเมื่อเป็นครุภัณฑ์เดิมที่ไม่มีหลักฐานชื่อหรือเลขระบุตัวตนครบถ้วน
                    ระบบจะบันทึกตามจริงโดยไม่บังคับหรือสร้างค่าหลอก (No fabricated
                    placeholders)
                  </p>
                </div>
              </label>
            </div>

            {/* Name / Description */}
            <div style={{ marginBottom: '1.25rem' }}>
              <label
                htmlFor="name"
                style={{
                  display: 'block',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  color: '#374151',
                  marginBottom: '0.375rem',
                }}
              >
                ชื่อหรือคำอธิบายครุภัณฑ์{' '}
                {isLegacy ? (
                  '(ไม่บังคับสำหรับข้อมูลตกทอด)'
                ) : (
                  <span style={{ color: '#dc2626' }}>*</span>
                )}
              </label>
              <input
                type="text"
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={
                  isLegacy
                    ? 'เว้นว่างได้หากไม่ทราบชื่อตามหลักฐานจริง'
                    : 'เช่น เครื่องคอมพิวเตอร์พกพา, เก้าอี้ทำงาน'
                }
                style={{
                  width: '100%',
                  padding: '0.625rem 0.75rem',
                  border: '1px solid #d1d5db',
                  borderRadius: '6px',
                  fontSize: '0.9375rem',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Identifiers Row */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: '1rem',
                marginBottom: '1.25rem',
              }}
            >
              <div>
                <label
                  htmlFor="asset_number"
                  style={{
                    display: 'block',
                    fontSize: '0.875rem',
                    fontWeight: 600,
                    color: '#374151',
                    marginBottom: '0.375rem',
                  }}
                >
                  เลขครุภัณฑ์ (Asset Number)
                </label>
                <input
                  type="text"
                  id="asset_number"
                  value={assetNumber}
                  onChange={(e) => setAssetNumber(e.target.value)}
                  placeholder="เว้นว่างได้หากไม่มี"
                  style={{
                    width: '100%',
                    padding: '0.625rem 0.75rem',
                    border: '1px solid #d1d5db',
                    borderRadius: '6px',
                    fontSize: '0.9375rem',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label
                  htmlFor="serial_number"
                  style={{
                    display: 'block',
                    fontSize: '0.875rem',
                    fontWeight: 600,
                    color: '#374151',
                    marginBottom: '0.375rem',
                  }}
                >
                  หมายเลขซีเรียล (Serial Number)
                </label>
                <input
                  type="text"
                  id="serial_number"
                  value={serialNumber}
                  onChange={(e) => setSerialNumber(e.target.value)}
                  placeholder="เว้นว่างได้หากไม่มี"
                  style={{
                    width: '100%',
                    padding: '0.625rem 0.75rem',
                    border: '1px solid #d1d5db',
                    borderRadius: '6px',
                    fontSize: '0.9375rem',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            </div>

            {/* Check Duplicates Button */}
            {(assetNumber || serialNumber) && (
              <div style={{ marginBottom: '1.25rem' }}>
                <button
                  type="button"
                  id="check-duplicate-btn"
                  onClick={handleCheckDuplicates}
                  disabled={isCheckingDuplicates}
                  style={{
                    padding: '0.375rem 0.75rem',
                    backgroundColor: '#f3f4f6',
                    border: '1px solid #d1d5db',
                    borderRadius: '4px',
                    fontSize: '0.8125rem',
                    color: '#374151',
                    cursor: isCheckingDuplicates ? 'not-allowed' : 'pointer',
                  }}
                >
                  {isCheckingDuplicates ? 'กำลังตรวจสอบ...' : '🔍 ตรวจสอบข้อมูลซ้ำ'}
                </button>
              </div>
            )}

            {/* Duplicate Candidate Warning Banner */}
            {candidates.length > 0 && (
              <div
                role="region"
                aria-label="การแจ้งเตือนข้อมูลซ้ำ"
                style={{
                  padding: '1rem',
                  backgroundColor: '#fffbeb',
                  border: '1px solid #f59e0b',
                  borderRadius: '6px',
                  marginBottom: '1.5rem',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    marginBottom: '0.5rem',
                  }}
                >
                  <span style={{ fontSize: '1.25rem' }}>⚠️</span>
                  <span
                    style={{
                      fontWeight: 600,
                      color: '#92400e',
                      fontSize: '0.9375rem',
                    }}
                  >
                    คำเตือน: พบครุภัณฑ์ที่มีเลขระบุตัวตนตรงกันในระบบ (
                    {candidates.length} รายการ)
                  </span>
                </div>
                <p
                  style={{
                    margin: '0 0 0.75rem 0',
                    fontSize: '0.8125rem',
                    color: '#78350f',
                  }}
                >
                  ระบบตรวจพบว่าเลขครุภัณฑ์หรือ Serial Number ตรงกับรายการเดิม
                  หากเป็นครุภัณฑ์คนละชิ้นที่ประสงค์จะลงทะเบียนแยก
                  โปรดทำเครื่องหมายยืนยันด้านล่าง
                </p>

                <div
                  style={{
                    maxHeight: '150px',
                    overflowY: 'auto',
                    marginBottom: '0.75rem',
                  }}
                >
                  <table
                    style={{
                      width: '100%',
                      fontSize: '0.8125rem',
                      borderCollapse: 'collapse',
                    }}
                  >
                    <thead>
                      <tr
                        style={{
                          borderBottom: '1px solid #fcd34d',
                          textAlign: 'left',
                          color: '#92400e',
                        }}
                      >
                        <th style={{ padding: '0.25rem' }}>Stable ID</th>
                        <th style={{ padding: '0.25rem' }}>ชื่อครุภัณฑ์</th>
                        <th style={{ padding: '0.25rem' }}>เลขครุภัณฑ์</th>
                        <th style={{ padding: '0.25rem' }}>Serial Number</th>
                      </tr>
                    </thead>
                    <tbody>
                      {candidates.map((cand) => (
                        <tr
                          key={cand.id}
                          style={{ borderBottom: '1px solid #fef3c7' }}
                        >
                          <td
                            style={{
                              padding: '0.25rem',
                              fontFamily: 'monospace',
                            }}
                          >
                            {cand.id.slice(0, 8)}...
                          </td>
                          <td style={{ padding: '0.25rem' }}>
                            {cand.name || '(ไม่ระบุชื่อ)'}
                          </td>
                          <td style={{ padding: '0.25rem' }}>
                            {cand.asset_number || '-'}
                          </td>
                          <td style={{ padding: '0.25rem' }}>
                            {cand.serial_number || '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    cursor: 'pointer',
                    fontWeight: 600,
                    fontSize: '0.875rem',
                    color: '#92400e',
                  }}
                >
                  <input
                    type="checkbox"
                    id="explicit_continuation"
                    checked={explicitContinuation}
                    onChange={(e) => setExplicitContinuation(e.target.checked)}
                    style={{ width: '1rem', height: '1rem' }}
                  />
                  <span>
                    ยืนยันลงทะเบียนเป็นครุภัณฑ์ชิ้นใหม่ต่างหาก (Explicit
                    Continuation)
                  </span>
                </label>
              </div>
            )}

            {/* Category (R2: optional/unset, display only) */}
            <div style={{ marginBottom: '1.25rem' }}>
              <label
                style={{
                  display: 'block',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  color: '#374151',
                  marginBottom: '0.375rem',
                }}
              >
                หมวดหมู่ครุภัณฑ์ (Category)
              </label>
              <div
                style={{
                  padding: '0.625rem 0.75rem',
                  backgroundColor: '#f3f4f6',
                  borderRadius: '6px',
                  border: '1px solid #e5e7eb',
                  fontSize: '0.875rem',
                  color: '#6b7280',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}
              >
                <span>🏷️ ยังไม่ระบุหมวดหมู่ (Uncategorized)</span>
                <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>
                  (รอชุดคำศัพท์ทางการจากส่วนกลาง)
                </span>
              </div>
            </div>

            {/* Source Reference / Notes */}
            <div style={{ marginBottom: '1.5rem' }}>
              <label
                htmlFor="source_reference"
                style={{
                  display: 'block',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  color: '#374151',
                  marginBottom: '0.375rem',
                }}
              >
                เอกสารอ้างอิง / บันทึกที่มา (Source Reference / Notes)
              </label>
              <textarea
                id="source_reference"
                value={sourceReference}
                onChange={(e) => setSourceReference(e.target.value)}
                rows={3}
                placeholder="บันทึกข้อเท็จจริง แหล่งที่มา เอกสารจัดซื้อ หรือข้อมูลตรวจรับตามจริง (เว้นว่างได้หากไม่มี)"
                style={{
                  width: '100%',
                  padding: '0.625rem 0.75rem',
                  border: '1px solid #d1d5db',
                  borderRadius: '6px',
                  fontSize: '0.9375rem',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Submit Button */}
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
              <button
                type="submit"
                id="submit-register-btn"
                disabled={
                  isSubmitting ||
                  (candidates.length > 0 && !explicitContinuation)
                }
                aria-busy={isSubmitting}
                style={{
                  padding: '0.625rem 1.5rem',
                  backgroundColor:
                    isSubmitting ||
                    (candidates.length > 0 && !explicitContinuation)
                      ? '#9ca3af'
                      : '#2563eb',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '6px',
                  fontSize: '0.9375rem',
                  fontWeight: 600,
                  cursor:
                    isSubmitting ||
                    (candidates.length > 0 && !explicitContinuation)
                      ? 'not-allowed'
                      : 'pointer',
                  transition: 'background-color 0.2s',
                }}
              >
                {isSubmitting ? 'กำลังบันทึกข้อมูล...' : 'บันทึกการลงทะเบียน'}
              </button>
              <Link
                to="/dashboard"
                style={{
                  color: '#4b5563',
                  textDecoration: 'none',
                  fontSize: '0.875rem',
                }}
              >
                ยกเลิก
              </Link>
            </div>
          </form>
        )}
      </div>
    </main>
  );
};

export default AssetRegister;
