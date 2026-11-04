import React, { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router';

export interface CreateAcquisitionResponse {
  id: string;
  acquisition_type: string | null;
  acquisition_date: string | null;
  total_amount: string | null;
  currency: string | null;
  source_reference: string | null;
  notes: string | null;
  recorded_at: string;
  created_by: string;
}

const PLACEHOLDER_STRINGS = new Set([
  '-',
  '--',
  '---',
  'n/a',
  'na',
  'none',
  'null',
  'undefined',
  '.',
  '..',
  '...',
  '?',
  '??',
  '???',
  'unknown',
  'blank',
  'empty',
  '-/-',
]);

function isPlaceholderText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (PLACEHOLDER_STRINGS.has(trimmed.toLowerCase())) return true;
  if (/^[\s\-_.~!?/\\*#@^&()+=]+$/.test(trimmed)) return true;
  return false;
}

export function normalizeDecimalString(val: string): { amount: string; currency: string } | null {
  const trimmed = val.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(0|[1-9]\d*)(\.(\d+))?$/);
  if (!match) {
    throw new Error('กรุณาระบุยอดเงินเป็นตัวเลขที่ถูกต้อง');
  }

  const integerPart = match[1];
  const fractionalPart = match[3];

  if (integerPart.length > 16) {
    throw new Error('ยอดเงินเกินขีดจำกัดสูงสุด (ไม่เกิน 16 หลักก่อนจุดทศนิยม)');
  }

  if (fractionalPart !== undefined && fractionalPart.length > 2) {
    throw new Error('กรุณาระบุทศนิยมไม่เกิน 2 ตำแหน่ง (ไม่อนุญาตให้ปัดเศษ)');
  }

  let formattedAmount: string;
  if (fractionalPart === undefined) {
    formattedAmount = `${integerPart}.00`;
  } else if (fractionalPart.length === 1) {
    formattedAmount = `${integerPart}.${fractionalPart}0`;
  } else {
    formattedAmount = `${integerPart}.${fractionalPart}`;
  }

  return { amount: formattedAmount, currency: 'THB' };
}

export const AcquisitionCreate: React.FC = () => {
  const [acquisitionType, setAcquisitionType] = useState('');
  const [acquisitionDate, setAcquisitionDate] = useState('');
  const [totalAmount, setTotalAmount] = useState('');
  const [sourceReference, setSourceReference] = useState('');
  const [notes, setNotes] = useState('');

  const [retryToken] = useState(() => crypto.randomUUID());
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [isLoadingSession, setIsLoadingSession] = useState(true);
  const [isVerifyingSession, setIsVerifyingSession] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isForbidden, setIsForbidden] = useState(false);

  const isMountedRef = React.useRef(true);
  const sessionGenRef = React.useRef(0);
  const submitGenRef = React.useRef(0);
  const isVerifyingSessionRef = React.useRef(false);
  const currentActorIdRef = React.useRef<string | null>(null);
  const submittingActorIdRef = React.useRef<string | null>(null);
  const sessionAbortControllerRef = React.useRef<AbortController | null>(null);
  const submitAbortControllerRef = React.useRef<AbortController | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    isMountedRef.current = true;

    const verifySession = async () => {
      // Immediately retire and abort any in-flight submit when verification starts
      if (submitAbortControllerRef.current) {
        submitAbortControllerRef.current.abort();
        submitAbortControllerRef.current = null;
      }
      submitGenRef.current += 1;
      setIsSubmitting(false);

      if (sessionAbortControllerRef.current) {
        sessionAbortControllerRef.current.abort();
      }
      const controller = new AbortController();
      sessionAbortControllerRef.current = controller;
      const currentGen = ++sessionGenRef.current;

      isVerifyingSessionRef.current = true;
      setIsVerifyingSession(true);

      try {
        const response = await fetch('/auth/session-check', {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });

        if (!isMountedRef.current || currentGen !== sessionGenRef.current) return;

        if (!response.ok) {
          setIsForbidden(false);
          navigate('/login', { replace: true });
          return;
        }

        const data = await response.json();
        if (!isMountedRef.current || currentGen !== sessionGenRef.current) return;

        const newActorId = data.user?.id || null;
        const previousActorId = currentActorIdRef.current;
        if (previousActorId && newActorId && previousActorId !== newActorId) {
          // Actor changed: reset actor-specific error/forbidden states
          setIsForbidden(false);
          setErrorMessage(null);
        }
        currentActorIdRef.current = newActorId;

        setCsrfToken(data.csrfToken || null);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        if (isMountedRef.current && currentGen === sessionGenRef.current) {
          navigate('/login', { replace: true });
        }
      } finally {
        if (isMountedRef.current && currentGen === sessionGenRef.current) {
          isVerifyingSessionRef.current = false;
          setIsVerifyingSession(false);
          setIsLoadingSession(false);
        }
      }
    };

    verifySession();

    const handleFocusRevalidate = () => {
      if (document.visibilityState === 'visible' && isMountedRef.current) {
        verifySession();
      }
    };

    window.addEventListener('focus', handleFocusRevalidate);
    document.addEventListener('visibilitychange', handleFocusRevalidate);

    return () => {
      isMountedRef.current = false;
      if (sessionAbortControllerRef.current) {
        sessionAbortControllerRef.current.abort();
      }
      if (submitAbortControllerRef.current) {
        submitAbortControllerRef.current.abort();
      }
      window.removeEventListener('focus', handleFocusRevalidate);
      document.removeEventListener('visibilitychange', handleFocusRevalidate);
    };
  }, [navigate]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (isSubmitting || isVerifyingSession || isLoadingSession || isForbidden) return;

    const trimmedType = acquisitionType.trim();
    const trimmedDate = acquisitionDate.trim();
    const trimmedAmount = totalAmount.trim();
    const trimmedRef = sourceReference.trim();
    const trimmedNotes = notes.trim();

    // D1 minimum facts check
    if (!trimmedType && !trimmedDate && !trimmedAmount && !trimmedRef && !trimmedNotes) {
      setErrorMessage(
        'กรุณาระบุข้อมูลการได้มาอย่างน้อยหนึ่งรายการตามจริง (เช่น ประเภทการได้มา, วันที่, ยอดเงิน, เอกสารอ้างอิง หรือหมายเหตุ)'
      );
      return;
    }

    if (trimmedType && isPlaceholderText(trimmedType)) {
      setErrorMessage(
        'ไม่อนุญาตให้ใช้ค่า "unknown", "n/a" หรือ "-" หากไม่ทราบข้อมูลให้เว้นว่างไว้ตามจริง'
      );
      return;
    }

    if (trimmedRef && isPlaceholderText(trimmedRef)) {
      setErrorMessage('เอกสารอ้างอิงต้องเป็นข้อมูลจริง ไม่อนุญาตให้ใช้ตัวยึด เช่น "-", "n/a"');
      return;
    }

    if (trimmedNotes && isPlaceholderText(trimmedNotes)) {
      setErrorMessage('หมายเหตุต้องเป็นข้อมูลจริง ไม่อนุญาตให้ใช้ตัวยึด เช่น "-", "n/a"');
      return;
    }

    let formattedAmount: string | null = null;
    let currency: string | null = null;
    if (trimmedAmount) {
      try {
        const normalized = normalizeDecimalString(trimmedAmount);
        if (normalized) {
          formattedAmount = normalized.amount;
          currency = normalized.currency;
        }
      } catch (err: any) {
        setErrorMessage(err.message || 'ยอดเงินไม่ถูกต้อง');
        return;
      }
    }

    const submitSessionGen = sessionGenRef.current;
    if (submitAbortControllerRef.current) {
      submitAbortControllerRef.current.abort();
    }
    const submitController = new AbortController();
    submitAbortControllerRef.current = submitController;
    const currentSubmitGen = ++submitGenRef.current;
    const submittingActorId = currentActorIdRef.current;
    submittingActorIdRef.current = submittingActorId;

    setIsSubmitting(true);
    setErrorMessage(null);

    const isSubmitValid = () => {
      return (
        isMountedRef.current &&
        currentSubmitGen === submitGenRef.current &&
        submitSessionGen === sessionGenRef.current &&
        !isVerifyingSessionRef.current &&
        currentActorIdRef.current === submittingActorId &&
        !submitController.signal.aborted
      );
    };

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-retry-token': retryToken,
      };
      if (csrfToken) {
        headers['x-csrf-token'] = csrfToken;
      }

      const bodyPayload = {
        acquisition_type: trimmedType || null,
        acquisition_date: trimmedDate || null,
        total_amount: formattedAmount,
        currency,
        source_reference: trimmedRef || null,
        notes: trimmedNotes || null,
        retry_token: retryToken,
      };

      const response = await fetch('/acquisitions', {
        method: 'POST',
        headers,
        credentials: 'include',
        signal: submitController.signal,
        body: JSON.stringify(bodyPayload),
      });

      if (!isSubmitValid()) return;

      if (response.status === 401) {
        if (!isSubmitValid()) return;
        setErrorMessage('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
        navigate('/login', { replace: true });
        return;
      }

      if (response.status === 403) {
        if (!isSubmitValid()) return;
        setIsForbidden(true);
        setErrorMessage('คุณไม่มีสิทธิ์บันทึกข้อมูลการได้มา (403 Forbidden)');
        return;
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        if (!isSubmitValid()) return;
        setErrorMessage(
          errorData?.message || 'ไม่สามารถบันทึกข้อมูลการได้มาได้ กรุณาตรวจสอบข้อมูล'
        );
        return;
      }

      const result: CreateAcquisitionResponse = await response.json().catch(() => null);
      if (!isSubmitValid()) return;

      if (result?.id) {
        navigate(`/acquisitions/${result.id}`);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      if (isSubmitValid()) {
        setErrorMessage('เกิดข้อผิดพลาดในการเชื่อมต่อเครือข่าย กรุณาลองใหม่อีกครั้ง');
      }
    } finally {
      if (isMountedRef.current && currentSubmitGen === submitGenRef.current) {
        setIsSubmitting(false);
      }
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
          กำลังตรวจสอบสิทธิ์การใช้งาน...
        </div>
      </main>
    );
  }

  const isGated = isSubmitting || isForbidden || isVerifyingSession || isLoadingSession;

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
        }}
      >
        <header style={{ marginBottom: '1.5rem' }}>
          <div style={{ marginBottom: '0.75rem' }}>
            <Link
              to="/dashboard"
              id="back-to-dashboard-link"
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
          </div>
          <h1
            id="create-acquisition-heading"
            style={{
              fontSize: '1.5rem',
              fontWeight: 600,
              margin: '0 0 0.5rem 0',
              color: '#111827',
            }}
          >
            บันทึกข้อมูลการได้มา (Acquisition Reference)
          </h1>
          <p style={{ margin: 0, fontSize: '0.875rem', color: '#4b5563' }}>
            สร้างรายการอ้างอิงการได้มาเพื่อใช้เชื่อมโยงกับครุภัณฑ์รายชิ้น
          </p>
        </header>

        {isVerifyingSession && (
          <div
            role="status"
            id="verifying-session-indicator"
            style={{
              padding: '0.5rem 0.75rem',
              marginBottom: '1rem',
              borderRadius: '4px',
              backgroundColor: '#f3f4f6',
              border: '1px solid #d1d5db',
              color: '#4b5563',
              fontSize: '0.875rem',
            }}
          >
            กำลังตรวจสอบสิทธิ์การใช้งาน...
          </div>
        )}

        {isForbidden && (
          <div
            role="alert"
            id="forbidden-alert"
            style={{
              padding: '0.75rem',
              marginBottom: '1.5rem',
              borderRadius: '4px',
              backgroundColor: '#fee2e2',
              border: '1px solid #ef4444',
              color: '#991b1b',
              fontSize: '0.875rem',
            }}
          >
            คุณไม่มีสิทธิ์ในการบันทึกข้อมูลการได้มา (ต้องการสิทธิ์ ASSET_CUSTODIAN)
          </div>
        )}

        {errorMessage && (
          <div
            role="alert"
            id="error-alert"
            style={{
              padding: '0.75rem',
              marginBottom: '1.5rem',
              borderRadius: '4px',
              backgroundColor: '#fee2e2',
              border: '1px solid #ef4444',
              color: '#991b1b',
              fontSize: '0.875rem',
            }}
          >
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <div style={{ marginBottom: '1.25rem' }}>
            <label
              htmlFor="acquisition_type"
              style={{
                display: 'block',
                fontSize: '0.875rem',
                fontWeight: 500,
                color: '#374151',
                marginBottom: '0.375rem',
              }}
            >
              ประเภทการได้มา (Acquisition Type)
            </label>
            <input
              id="acquisition_type"
              type="text"
              value={acquisitionType}
              onChange={(e) => setAcquisitionType(e.target.value)}
              placeholder="เช่น จัดซื้อปกติ, เงินบริจาค, รับโอน"
              disabled={isGated}
              style={{
                width: '100%',
                padding: '0.5rem 0.75rem',
                border: '1px solid #d1d5db',
                borderRadius: '4px',
                fontSize: '0.875rem',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{ marginBottom: '1.25rem' }}>
            <label
              htmlFor="acquisition_date"
              style={{
                display: 'block',
                fontSize: '0.875rem',
                fontWeight: 500,
                color: '#374151',
                marginBottom: '0.375rem',
              }}
            >
              วันที่ได้มา (Acquisition Date - ค.ศ.)
            </label>
            <input
              id="acquisition_date"
              type="date"
              value={acquisitionDate}
              onChange={(e) => setAcquisitionDate(e.target.value)}
              disabled={isGated}
              style={{
                width: '100%',
                padding: '0.5rem 0.75rem',
                border: '1px solid #d1d5db',
                borderRadius: '4px',
                fontSize: '0.875rem',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{ marginBottom: '1.25rem' }}>
            <label
              htmlFor="total_amount"
              style={{
                display: 'block',
                fontSize: '0.875rem',
                fontWeight: 500,
                color: '#374151',
                marginBottom: '0.375rem',
              }}
            >
              มูลค่ารวมทั้งชุด (Total Amount - บาท THB)
            </label>
            <input
              id="total_amount"
              type="text"
              value={totalAmount}
              onChange={(e) => setTotalAmount(e.target.value)}
              placeholder="เช่น 125000.00"
              disabled={isGated}
              style={{
                width: '100%',
                padding: '0.5rem 0.75rem',
                border: '1px solid #d1d5db',
                borderRadius: '4px',
                fontSize: '0.875rem',
                boxSizing: 'border-box',
              }}
            />
            <span style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: '0.25rem', display: 'block' }}>
              * มูลค่านี้เป็นยอดรวมของการได้มาทั้งชุด (Whole-Acquisition Total) ไม่ใช่ราคาต่อชิ้น
            </span>
          </div>

          <div style={{ marginBottom: '1.25rem' }}>
            <label
              htmlFor="source_reference"
              style={{
                display: 'block',
                fontSize: '0.875rem',
                fontWeight: 500,
                color: '#374151',
                marginBottom: '0.375rem',
              }}
            >
              เอกสาร / สัญญาอ้างอิง (Source Reference)
            </label>
            <input
              id="source_reference"
              type="text"
              value={sourceReference}
              onChange={(e) => setSourceReference(e.target.value)}
              placeholder="เช่น เลขที่สัญญา PO-2026-0042"
              disabled={isGated}
              style={{
                width: '100%',
                padding: '0.5rem 0.75rem',
                border: '1px solid #d1d5db',
                borderRadius: '4px',
                fontSize: '0.875rem',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{ marginBottom: '1.5rem' }}>
            <label
              htmlFor="notes"
              style={{
                display: 'block',
                fontSize: '0.875rem',
                fontWeight: 500,
                color: '#374151',
                marginBottom: '0.375rem',
              }}
            >
              หมายเหตุ (Notes)
            </label>
            <textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="ระบุข้อความหรือรายละเอียดเพิ่มเติมตามจริง"
              rows={3}
              disabled={isGated}
              style={{
                width: '100%',
                padding: '0.5rem 0.75rem',
                border: '1px solid #d1d5db',
                borderRadius: '4px',
                fontSize: '0.875rem',
                boxSizing: 'border-box',
                fontFamily: 'inherit',
              }}
            />
          </div>

          <button
            id="submit-acquisition-btn"
            type="submit"
            disabled={isGated}
            style={{
              width: '100%',
              padding: '0.75rem 1rem',
              backgroundColor: isGated ? '#9ca3af' : '#059669',
              color: '#ffffff',
              border: 'none',
              borderRadius: '4px',
              fontSize: '0.9375rem',
              fontWeight: 500,
              cursor: isGated ? 'not-allowed' : 'pointer',
            }}
          >
            {isSubmitting ? 'กำลังบันทึกข้อมูล...' : isVerifyingSession ? 'กำลังตรวจสอบสิทธิ์...' : 'บันทึกข้อมูลการได้มา'}
          </button>
        </form>
      </div>
    </main>
  );
};
