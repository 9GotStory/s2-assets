import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router';

export interface BulkItemFormState {
  item_key: string;
  name: string;
  asset_number: string;
  serial_number: string;
  source_reference: string;
  source_notes: string;
  is_legacy: boolean;
}

export interface DuplicateWarningInfo {
  item_key: string;
  field: 'asset_number' | 'serial_number';
  value: string;
  intra_batch: boolean;
  intra_batch_keys?: string[];
  candidates: Array<{
    id: string;
    name: string | null;
    asset_number: string | null;
    serial_number: string | null;
  }>;
  total_count: number;
  has_more: boolean;
  limit: number;
  offset: number;
  raw_next_offset?: number;
}

export interface BulkRegistrationSuccessResult {
  total_registered: number;
  shared_acquisition_id: string | null;
  results: Array<{
    item_key: string;
    asset_id: string;
    history_id: string;
  }>;
}

export interface UncertainSnapshot {
  actorId: string;
  retryToken: string;
  payload: any;
}

export const AssetBulkRegister: React.FC = () => {
  const [searchParams] = useSearchParams();
  const initialAcquisitionId = searchParams.get('acquisition_id') || '';

  const [sharedAcquisitionId, setSharedAcquisitionId] = useState(initialAcquisitionId);
  const [items, setItems] = useState<BulkItemFormState[]>([
    {
      item_key: crypto.randomUUID(),
      name: '',
      asset_number: '',
      serial_number: '',
      source_reference: '',
      source_notes: '',
      is_legacy: false,
    },
  ]);
  const [explicitContinuation, setExplicitContinuation] = useState(false);
  const [retryToken, setRetryToken] = useState(() => crypto.randomUUID());

  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [isLoadingSession, setIsLoadingSession] = useState(true);
  const [isVerifyingSession, setIsVerifyingSession] = useState(false);
  const [forbiddenError, setForbiddenError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<DuplicateWarningInfo[]>([]);
  const [successResult, setSuccessResult] = useState<BulkRegistrationSuccessResult | null>(null);
  const [uncertainSnapshot, setUncertainSnapshot] = useState<UncertainSnapshot | null>(null);
  const [loadingMoreKey, setLoadingMoreKey] = useState<string | null>(null);

  const isMountedRef = useRef(true);
  const sessionGenRef = useRef(0);
  const submitGenRef = useRef(0);
  const loadMoreGenRef = useRef(0);
  const currentActorIdRef = useRef<string | null>(null);
  const submittingActorIdRef = useRef<string | null>(null);
  const pendingIntentRef = useRef<UncertainSnapshot | null>(null);
  const sessionAbortControllerRef = useRef<AbortController | null>(null);
  const submitAbortControllerRef = useRef<AbortController | null>(null);
  const loadMoreAbortControllerRef = useRef<AbortController | null>(null);

  const warningsRef = useRef<DuplicateWarningInfo[]>(warnings);
  warningsRef.current = warnings;
  const successResultRef = useRef<BulkRegistrationSuccessResult | null>(successResult);
  successResultRef.current = successResult;

  const navigate = useNavigate();

  // Session verification on mount, focus, and visibility change
  const verifySession = useCallback(async () => {
    // Synchronously assert verification gate and retire in-flight submits
    setIsVerifyingSession(true);
    if (submitAbortControllerRef.current) {
      submitAbortControllerRef.current.abort();
      submitAbortControllerRef.current = null;
    }
    ++submitGenRef.current;
    setIsSubmitting(false);

    // If an in-flight submit was running, preserve intent snapshot into uncertainSnapshot (F2)
    if (pendingIntentRef.current) {
      setUncertainSnapshot(pendingIntentRef.current);
      setErrorMessage(
        'ไม่ได้รับผลลัพธ์จากเซิร์ฟเวอร์เนื่องจากมีการตรวจสอบสิทธิ์ระหว่างส่งข้อมูล คำขออาจถูกบันทึกแล้ว กรุณากด "ลองส่งใหม่อีกครั้งด้วยข้อมูลเดิม" เพื่อยืนยันผลลัพธ์'
      );
    }

    // Abort active candidate load-more requests on session verification (F1)
    if (loadMoreAbortControllerRef.current) {
      loadMoreAbortControllerRef.current.abort();
      loadMoreAbortControllerRef.current = null;
    }
    ++loadMoreGenRef.current;
    setLoadingMoreKey(null);

    if (sessionAbortControllerRef.current) {
      sessionAbortControllerRef.current.abort();
    }
    const controller = new AbortController();
    sessionAbortControllerRef.current = controller;
    const currentGen = ++sessionGenRef.current;

    try {
      const response = await fetch('/auth/session-check', {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal,
      });

      if (!isMountedRef.current || currentGen !== sessionGenRef.current || controller.signal.aborted) {
        return;
      }

      if (response.status === 401) {
        currentActorIdRef.current = null;
        pendingIntentRef.current = null;
        setUncertainSnapshot(null);
        setWarnings([]);
        setSuccessResult(null);
        navigate('/login', { replace: true });
        return;
      }

      if (response.status === 403) {
        setForbiddenError('คุณไม่มีสิทธิ์ในการเข้าถึงหน้านี้');
        setWarnings([]);
        setSuccessResult(null);
        // Retain uncertainSnapshot if present for quarantined recovery (F2)
        setIsVerifyingSession(false);
        setIsLoadingSession(false);
        return;
      }

      if (!response.ok) {
        currentActorIdRef.current = null;
        pendingIntentRef.current = null;
        setUncertainSnapshot(null);
        setWarnings([]);
        setSuccessResult(null);
        navigate('/login', { replace: true });
        return;
      }

      const data = await response.json();
      if (!isMountedRef.current || currentGen !== sessionGenRef.current || controller.signal.aborted) {
        return;
      }

      const actorId = data?.user?.id;
      if (!actorId) {
        currentActorIdRef.current = null;
        pendingIntentRef.current = null;
        setUncertainSnapshot(null);
        setWarnings([]);
        setSuccessResult(null);
        navigate('/login', { replace: true });
        return;
      }

      const isSameActor = currentActorIdRef.current === actorId;

      // Check if actor changed -> synchronously retire previous actor's draft and intent
      if (currentActorIdRef.current !== null && !isSameActor) {
        setItems([
          {
            item_key: crypto.randomUUID(),
            name: '',
            asset_number: '',
            serial_number: '',
            source_reference: '',
            source_notes: '',
            is_legacy: false,
          },
        ]);
        setSharedAcquisitionId('');
        setSuccessResult(null);
        setWarnings([]);
        setErrorMessage(null);
        setExplicitContinuation(false);
        setUncertainSnapshot(null);
        pendingIntentRef.current = null;
        setRetryToken(crypto.randomUUID());
      }

      // F1: A valid session alone must NOT restore cached protected facts without revalidation through protected authority
      const cachedWarnings = warningsRef.current;
      const cachedSuccess = successResultRef.current;

      if (isSameActor && cachedWarnings.length > 0) {
        const dbWarnings = cachedWarnings.filter(
          (w) => !w.intra_batch && typeof w.value === 'string' && w.value.length > 0
        );
        if (dbWarnings.length > 0) {
          try {
            const revalidatePromises = dbWarnings.map((w) =>
              fetch(`/assets/duplicate-candidates?${w.field}=${encodeURIComponent(w.value)}&limit=50&offset=0`, {
                method: 'GET',
                credentials: 'include',
                signal: controller.signal,
              })
            );
            const revalResponses = await Promise.all(revalidatePromises);

            if (!isMountedRef.current || currentGen !== sessionGenRef.current || controller.signal.aborted) {
              return;
            }

            const anyForbidden = revalResponses.some((r) => r.status === 403);
            const anyUnauthorized = revalResponses.some((r) => r.status === 401);

            if (anyUnauthorized) {
              navigate('/login', { replace: true });
              return;
            }

            if (anyForbidden) {
              setForbiddenError('คุณไม่มีสิทธิ์ในการเข้าถึงข้อมูลการตรวจสอบรายการซ้ำ');
              setWarnings([]);
              setSuccessResult(null);
              setIsVerifyingSession(false);
              setIsLoadingSession(false);
              return;
            }

            const allOk = revalResponses.every((r) => r.ok);
            if (allOk) {
              const freshDataList = await Promise.all(revalResponses.map((r) => r.json()));
              if (!isMountedRef.current || currentGen !== sessionGenRef.current || controller.signal.aborted) {
                return;
              }
              setWarnings((prev) => {
                let dbIdx = 0;
                return prev.map((w) => {
                  if (w.intra_batch || typeof w.value !== 'string' || w.value.length === 0) return w;
                  const fresh = freshDataList[dbIdx++];
                  if (!fresh) return w;
                  return {
                    ...w,
                    candidates: Array.isArray(fresh.candidates) ? fresh.candidates : [],
                    total_count: typeof fresh.total_count === 'number' ? fresh.total_count : w.total_count,
                    has_more: Boolean(fresh.has_more),
                    offset: typeof fresh.offset === 'number' ? fresh.offset : 0,
                    raw_next_offset:
                      (typeof fresh.offset === 'number' ? fresh.offset : 0) +
                      (typeof fresh.limit === 'number' ? fresh.limit : 50),
                  };
                });
              });
            } else {
              setWarnings([]);
            }
          } catch (revalErr: unknown) {
            if (revalErr instanceof DOMException && revalErr.name === 'AbortError') {
              return;
            }
            setWarnings([]);
          }
        }
      }

      if (isSameActor && cachedSuccess && cachedSuccess.results.length > 0) {
        try {
          const firstAssetId = cachedSuccess.results[0].asset_id;
          const assetRes = await fetch(`/assets/${firstAssetId}`, {
            method: 'GET',
            credentials: 'include',
            signal: controller.signal,
          });
          if (!isMountedRef.current || currentGen !== sessionGenRef.current || controller.signal.aborted) {
            return;
          }
          if (assetRes.status === 403) {
            setForbiddenError('คุณไม่มีสิทธิ์ในการดูข้อมูลครุภัณฑ์');
            setSuccessResult(null);
            setIsVerifyingSession(false);
            setIsLoadingSession(false);
            return;
          }
          if (assetRes.status === 401) {
            navigate('/login', { replace: true });
            return;
          }
          if (!assetRes.ok) {
            setSuccessResult(null);
          }
        } catch (assetErr: unknown) {
          if (assetErr instanceof DOMException && assetErr.name === 'AbortError') {
            return;
          }
          setSuccessResult(null);
        }
      }

      currentActorIdRef.current = actorId;
      setCsrfToken(data.csrfToken || null);
      setForbiddenError(null);
      setIsVerifyingSession(false);
      setIsLoadingSession(false);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      if (isMountedRef.current && currentGen === sessionGenRef.current) {
        currentActorIdRef.current = null;
        pendingIntentRef.current = null;
        setUncertainSnapshot(null);
        setWarnings([]);
        setSuccessResult(null);
        navigate('/login', { replace: true });
      }
    }
  }, [navigate]);

  useEffect(() => {
    isMountedRef.current = true;
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
      ++sessionGenRef.current;
      ++submitGenRef.current;
      ++loadMoreGenRef.current;
      window.removeEventListener('focus', handleFocusRevalidate);
      document.removeEventListener('visibilitychange', handleFocusRevalidate);
      sessionAbortControllerRef.current?.abort();
      submitAbortControllerRef.current?.abort();
      loadMoreAbortControllerRef.current?.abort();
    };
  }, [verifySession]);

  const handleAddItem = () => {
    if (uncertainSnapshot) return;
    if (items.length >= 100) {
      setErrorMessage('สามารถลงทะเบียนได้สูงสุด 100 รายการต่อครั้ง');
      return;
    }
    if (loadMoreAbortControllerRef.current) {
      loadMoreAbortControllerRef.current.abort();
      loadMoreAbortControllerRef.current = null;
    }
    ++loadMoreGenRef.current;
    setLoadingMoreKey(null);
    setItems((prev) => [
      ...prev,
      {
        item_key: crypto.randomUUID(),
        name: '',
        asset_number: '',
        serial_number: '',
        source_reference: '',
        source_notes: '',
        is_legacy: false,
      },
    ]);
    // Reset duplicate warnings and explicit continuation on intent change
    setWarnings([]);
    setExplicitContinuation(false);
    setErrorMessage(null);
  };

  const handleRemoveItem = (index: number) => {
    if (uncertainSnapshot) return;
    if (items.length <= 1) return;
    if (loadMoreAbortControllerRef.current) {
      loadMoreAbortControllerRef.current.abort();
      loadMoreAbortControllerRef.current = null;
    }
    ++loadMoreGenRef.current;
    setLoadingMoreKey(null);
    setItems((prev) => prev.filter((_, i) => i !== index));
    // Reset duplicate warnings and explicit continuation on intent change
    setWarnings([]);
    setExplicitContinuation(false);
    setErrorMessage(null);
  };

  const handleItemChange = (
    index: number,
    field: keyof BulkItemFormState,
    value: string | boolean
  ) => {
    if (uncertainSnapshot) return;
    if (loadMoreAbortControllerRef.current) {
      loadMoreAbortControllerRef.current.abort();
      loadMoreAbortControllerRef.current = null;
    }
    ++loadMoreGenRef.current;
    setLoadingMoreKey(null);
    setItems((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], [field]: value };
      return copy;
    });
    // Reset duplicate warnings and explicit continuation on intent change
    setWarnings([]);
    setExplicitContinuation(false);
    setErrorMessage(null);
  };

  const handleSharedAcquisitionChange = (value: string) => {
    if (uncertainSnapshot) return;
    if (loadMoreAbortControllerRef.current) {
      loadMoreAbortControllerRef.current.abort();
      loadMoreAbortControllerRef.current = null;
    }
    ++loadMoreGenRef.current;
    setLoadingMoreKey(null);
    setSharedAcquisitionId(value);
    // Reset duplicate warnings and explicit continuation on intent change
    setWarnings([]);
    setExplicitContinuation(false);
    setErrorMessage(null);
  };

  // Submit handler: validates input, builds verbatim payload, sends request
  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (isSubmitting || isVerifyingSession || isLoadingSession || Boolean(uncertainSnapshot) || Boolean(forbiddenError)) {
      return;
    }

    // Client-side validations
    if (items.length === 0 || items.length > 100) {
      setErrorMessage('กรุณาระบุจำนวนรายการระหว่าง 1 ถึง 100 รายการ');
      return;
    }

    for (let i = 0; i < items.length; i++) {
      const itm = items[i];
      if (!itm.is_legacy && !itm.name.trim()) {
        setErrorMessage(`รายการที่ ${i + 1}: กรุณาระบุชื่อครุภัณฑ์ (หรือระบุว่าเป็นข้อมูลเก่า)`);
        return;
      }
    }

    const trimmedAcqId = sharedAcquisitionId.trim();
    if (
      trimmedAcqId &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmedAcqId)
    ) {
      setErrorMessage('รหัสการได้มาต้องเป็นรูปแบบ UUID ที่ถูกต้อง');
      return;
    }

    if (warnings.length > 0 && !explicitContinuation) {
      setErrorMessage('พบข้อมูลซ้ำ กรุณาตรวจสอบคำเตือนและกดยืนยันการลงทะเบียนเป็นครุภัณฑ์ชิ้นใหม่ต่างหาก');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    // Abort active candidate load-more requests on submit
    if (loadMoreAbortControllerRef.current) {
      loadMoreAbortControllerRef.current.abort();
      loadMoreAbortControllerRef.current = null;
    }
    ++loadMoreGenRef.current;
    setLoadingMoreKey(null);

    const currentSubmitGen = ++submitGenRef.current;
    submittingActorIdRef.current = currentActorIdRef.current;

    if (submitAbortControllerRef.current) {
      submitAbortControllerRef.current.abort();
    }
    const controller = new AbortController();
    submitAbortControllerRef.current = controller;

    // Build payload preserving verbatim nonempty identifiers (F3)
    const payload = {
      acquisition_id: trimmedAcqId || null,
      explicit_continuation: explicitContinuation,
      items: items.map((itm) => ({
        item_key: itm.item_key,
        name: itm.name.trim() || null,
        asset_number: itm.asset_number !== '' ? itm.asset_number : null,
        serial_number: itm.serial_number !== '' ? itm.serial_number : null,
        source_reference: itm.source_reference.trim() || null,
        source_notes: itm.source_notes.trim() || null,
        is_legacy: itm.is_legacy,
      })),
    };

    const intentSnapshot: UncertainSnapshot = {
      actorId: currentActorIdRef.current!,
      retryToken,
      payload,
    };
    pendingIntentRef.current = intentSnapshot;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-retry-token': retryToken,
    };
    if (csrfToken) {
      headers['x-csrf-token'] = csrfToken;
    }

    try {
      const response = await fetch('/assets/bulk-register', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      // Post-fetch ownership & epoch validation
      if (
        !isMountedRef.current ||
        currentSubmitGen !== submitGenRef.current ||
        controller.signal.aborted ||
        submittingActorIdRef.current !== currentActorIdRef.current
      ) {
        return;
      }

      if (response.status === 401) {
        pendingIntentRef.current = null;
        setUncertainSnapshot(null);
        currentActorIdRef.current = null;
        navigate('/login', { replace: true });
        return;
      }

      if (response.status === 403) {
        pendingIntentRef.current = null;
        setUncertainSnapshot(null);
        setForbiddenError('คุณไม่มีสิทธิ์ในการลงทะเบียนครุภัณฑ์แบบกลุ่ม (ต้องมีบทบาทผู้ดูแลทะเบียนพัสดุ)');
        setErrorMessage('คุณไม่มีสิทธิ์ในการลงทะเบียนครุภัณฑ์แบบกลุ่ม (ต้องมีบทบาทผู้ดูแลทะเบียนพัสดุ)');
        setWarnings([]);
        setSuccessResult(null);
        setIsSubmitting(false);
        return;
      }

      if (response.status === 409) {
        const errorData = await response.json();
        if (
          !isMountedRef.current ||
          currentSubmitGen !== submitGenRef.current ||
          controller.signal.aborted ||
          submittingActorIdRef.current !== currentActorIdRef.current
        ) {
          return;
        }

        pendingIntentRef.current = null;
        setUncertainSnapshot(null);

        if (errorData.code === 'DUPLICATE_CANDIDATES_FOUND' && Array.isArray(errorData.warnings)) {
          const mappedWarnings: DuplicateWarningInfo[] = errorData.warnings.map((w: any) => ({
            ...w,
            intra_batch: Boolean(w.intra_batch),
            candidates: Array.isArray(w.candidates) ? w.candidates : [],
            total_count: typeof w.total_count === 'number' ? w.total_count : 0,
            has_more: Boolean(w.has_more),
            limit: typeof w.limit === 'number' ? w.limit : 50,
            offset: typeof w.offset === 'number' ? w.offset : 0,
            raw_next_offset:
              (typeof w.offset === 'number' ? w.offset : 0) + (typeof w.limit === 'number' ? w.limit : 50),
          }));
          setWarnings(mappedWarnings);
          setErrorMessage('พบข้อมูลเลขครุภัณฑ์หรือซีเรียลซ้ำในระบบหรือในชุดข้อมูล กรุณาตรวจสอบคำเตือน');
        } else if (errorData.code === 'RETRY_TOKEN_PAYLOAD_MISMATCH') {
          setErrorMessage('คำขอซ้ำขัดแย้ง: ข้อมูลในแบบฟอร์มถูกแก้ไขภายใต้โทเค็นเดิม');
        } else {
          setErrorMessage(errorData.message || 'เกิดข้อขัดแย้งในการลงทะเบียน');
        }
        setIsSubmitting(false);
        return;
      }

      if (response.status >= 500) {
        // Generic 5xx handling: server may have committed the transaction before error (F2)
        if (
          isMountedRef.current &&
          currentSubmitGen === submitGenRef.current &&
          submittingActorIdRef.current === currentActorIdRef.current
        ) {
          setUncertainSnapshot(intentSnapshot);
          setErrorMessage(
            `เกิดข้อผิดพลาดจากเซิร์ฟเวอร์ (HTTP ${response.status}) คำขออาจถูกบันทึกแล้ว กรุณากด "ลองส่งใหม่อีกครั้งด้วยข้อมูลเดิม" เพื่อตรวจสอบและยืนยันผลลัพธ์`
          );
        }
        setIsSubmitting(false);
        return;
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        if (
          !isMountedRef.current ||
          currentSubmitGen !== submitGenRef.current ||
          controller.signal.aborted ||
          submittingActorIdRef.current !== currentActorIdRef.current
        ) {
          return;
        }
        pendingIntentRef.current = null;
        setUncertainSnapshot(null);
        setErrorMessage(errorData?.message || 'เกิดข้อผิดพลาดในการลงทะเบียนแบบกลุ่ม');
        setIsSubmitting(false);
        return;
      }

      const successData: BulkRegistrationSuccessResult = await response.json();
      if (
        !isMountedRef.current ||
        currentSubmitGen !== submitGenRef.current ||
        controller.signal.aborted ||
        submittingActorIdRef.current !== currentActorIdRef.current
      ) {
        return;
      }

      pendingIntentRef.current = null;
      setUncertainSnapshot(null);
      setSuccessResult(successData);
      setIsSubmitting(false);
    } catch (err: unknown) {
      if (
        !isMountedRef.current ||
        currentSubmitGen !== submitGenRef.current ||
        submittingActorIdRef.current !== currentActorIdRef.current
      ) {
        return;
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        setUncertainSnapshot(intentSnapshot);
        setErrorMessage(
          'ไม่ได้รับผลลัพธ์จากเซิร์ฟเวอร์เนื่องจากคำขอถูกระงับ คำขออาจถูกบันทึกแล้ว กรุณากด "ลองส่งใหม่อีกครั้งด้วยข้อมูลเดิม" เพื่อยืนยันผลลัพธ์'
        );
        setIsSubmitting(false);
        return;
      }
      // Lost response -> enter uncertain state preserving immutable snapshot and token (F2)
      setUncertainSnapshot(intentSnapshot);
      setErrorMessage(
        'ไม่ได้รับผลลัพธ์จากเซิร์ฟเวอร์ คำขออาจถูกบันทึกแล้ว กรุณากด "ลองส่งใหม่อีกครั้งด้วยข้อมูลเดิม" เพื่อยืนยันผลลัพธ์'
      );
      setIsSubmitting(false);
    }
  };

  // Retry uncertain submission with exact stored snapshot and retry token (F2)
  const handleRetryUncertain = async () => {
    if (!uncertainSnapshot || isSubmitting || isVerifyingSession || Boolean(forbiddenError)) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    const currentSubmitGen = ++submitGenRef.current;
    submittingActorIdRef.current = currentActorIdRef.current;
    pendingIntentRef.current = uncertainSnapshot;

    if (submitAbortControllerRef.current) {
      submitAbortControllerRef.current.abort();
    }
    const controller = new AbortController();
    submitAbortControllerRef.current = controller;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-retry-token': uncertainSnapshot.retryToken,
    };
    if (csrfToken) {
      headers['x-csrf-token'] = csrfToken;
    }

    try {
      const response = await fetch('/assets/bulk-register', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(uncertainSnapshot.payload),
        signal: controller.signal,
      });

      if (
        !isMountedRef.current ||
        currentSubmitGen !== submitGenRef.current ||
        controller.signal.aborted ||
        submittingActorIdRef.current !== currentActorIdRef.current
      ) {
        return;
      }

      if (response.status === 401) {
        pendingIntentRef.current = null;
        setUncertainSnapshot(null);
        currentActorIdRef.current = null;
        navigate('/login', { replace: true });
        return;
      }

      if (response.status === 403) {
        // F2: Denied replay must NOT destroy the original unresolved snapshot
        // Retain uncertainSnapshot for quarantined recovery once authority is restored!
        setForbiddenError('คุณไม่มีสิทธิ์ในการลงทะเบียนครุภัณฑ์แบบกลุ่ม');
        setWarnings([]);
        setSuccessResult(null);
        setIsSubmitting(false);
        return;
      }

      if (response.status === 409) {
        const errorData = await response.json();
        if (
          !isMountedRef.current ||
          currentSubmitGen !== submitGenRef.current ||
          controller.signal.aborted ||
          submittingActorIdRef.current !== currentActorIdRef.current
        ) {
          return;
        }

        pendingIntentRef.current = null;
        setUncertainSnapshot(null);

        if (errorData.code === 'DUPLICATE_CANDIDATES_FOUND' && Array.isArray(errorData.warnings)) {
          const mappedWarnings: DuplicateWarningInfo[] = errorData.warnings.map((w: any) => ({
            ...w,
            intra_batch: Boolean(w.intra_batch),
            candidates: Array.isArray(w.candidates) ? w.candidates : [],
            total_count: typeof w.total_count === 'number' ? w.total_count : 0,
            has_more: Boolean(w.has_more),
            limit: typeof w.limit === 'number' ? w.limit : 50,
            offset: typeof w.offset === 'number' ? w.offset : 0,
            raw_next_offset:
              (typeof w.offset === 'number' ? w.offset : 0) + (typeof w.limit === 'number' ? w.limit : 50),
          }));
          setWarnings(mappedWarnings);
          setErrorMessage('พบข้อมูลเลขครุภัณฑ์หรือซีเรียลซ้ำในระบบหรือในชุดข้อมูล กรุณาตรวจสอบคำเตือน');
        } else if (errorData.code === 'RETRY_TOKEN_PAYLOAD_MISMATCH') {
          setErrorMessage('คำขอซ้ำขัดแย้ง: ข้อมูลในแบบฟอร์มถูกแก้ไขภายใต้โทเค็นเดิม');
        } else {
          setErrorMessage(errorData.message || 'เกิดข้อขัดแย้งในการลงทะเบียน');
        }
        setIsSubmitting(false);
        return;
      }

      if (response.status >= 500) {
        setErrorMessage(
          `เกิดข้อผิดพลาดจากเซิร์ฟเวอร์ (HTTP ${response.status}) กรุณาลองส่งใหม่อีกครั้งด้วยข้อมูลเดิม`
        );
        setIsSubmitting(false);
        return;
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        if (
          !isMountedRef.current ||
          currentSubmitGen !== submitGenRef.current ||
          controller.signal.aborted ||
          submittingActorIdRef.current !== currentActorIdRef.current
        ) {
          return;
        }
        pendingIntentRef.current = null;
        setUncertainSnapshot(null);
        setErrorMessage(errorData?.message || 'เกิดข้อผิดพลาดในการลองส่งใหม่');
        setIsSubmitting(false);
        return;
      }

      const successData: BulkRegistrationSuccessResult = await response.json();
      if (
        !isMountedRef.current ||
        currentSubmitGen !== submitGenRef.current ||
        controller.signal.aborted ||
        submittingActorIdRef.current !== currentActorIdRef.current
      ) {
        return;
      }

      pendingIntentRef.current = null;
      setUncertainSnapshot(null);
      setSuccessResult(successData);
      setIsSubmitting(false);
    } catch (err: unknown) {
      if (
        !isMountedRef.current ||
        currentSubmitGen !== submitGenRef.current ||
        submittingActorIdRef.current !== currentActorIdRef.current
      ) {
        return;
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        setIsSubmitting(false);
        return;
      }
      setErrorMessage('ยังคงไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองส่งใหม่อีกครั้ง');
      setIsSubmitting(false);
    }
  };

  // Discard uncertain submission to start fresh (F2)
  const handleDiscardUncertain = () => {
    pendingIntentRef.current = null;
    setUncertainSnapshot(null);
    setRetryToken(crypto.randomUUID());
    setErrorMessage(null);
    setWarnings([]);
    setExplicitContinuation(false);
  };

  // Load more duplicate candidates for a specific warning using existing endpoint (F1, F4)
  const handleLoadMoreCandidates = async (
    itemKey: string,
    field: 'asset_number' | 'serial_number'
  ) => {
    if (isVerifyingSession || Boolean(forbiddenError) || Boolean(uncertainSnapshot)) return;

    const targetWarning = warnings.find((w) => w.item_key === itemKey && w.field === field);
    if (!targetWarning || !targetWarning.has_more) return;

    const loadKey = `${itemKey}:${field}`;
    if (loadingMoreKey === loadKey) return;

    if (loadMoreAbortControllerRef.current) {
      loadMoreAbortControllerRef.current.abort();
    }
    const controller = new AbortController();
    loadMoreAbortControllerRef.current = controller;
    const currentGen = ++loadMoreGenRef.current;
    const targetActorId = currentActorIdRef.current;

    setLoadingMoreKey(loadKey);
    setErrorMessage(null);

    // F4: nextOffset uses raw consumed server offset, NOT deduplicated display length
    const nextOffset =
      targetWarning.raw_next_offset ??
      ((targetWarning.offset || 0) + (targetWarning.limit || 50));
    const queryParam = `${targetWarning.field}=${encodeURIComponent(targetWarning.value)}&limit=50&offset=${nextOffset}`;

    try {
      const response = await fetch(`/assets/duplicate-candidates?${queryParam}`, {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal,
      });

      if (
        !isMountedRef.current ||
        currentGen !== loadMoreGenRef.current ||
        controller.signal.aborted ||
        targetActorId !== currentActorIdRef.current
      ) {
        return;
      }

      if (response.status === 401) {
        currentActorIdRef.current = null;
        pendingIntentRef.current = null;
        setUncertainSnapshot(null);
        setWarnings([]);
        setSuccessResult(null);
        navigate('/login', { replace: true });
        return;
      }

      if (response.status === 403) {
        setForbiddenError('คุณไม่มีสิทธิ์ในการตรวจสอบข้อมูลซ้ำ');
        setWarnings([]);
        return;
      }

      if (!response.ok) {
        setErrorMessage('เกิดข้อผิดพลาดในการโหลดข้อมูลซ้ำเพิ่มเติม กรุณาลองใหม่อีกครั้ง');
        return;
      }

      const data = await response.json();
      if (
        !isMountedRef.current ||
        currentGen !== loadMoreGenRef.current ||
        controller.signal.aborted ||
        targetActorId !== currentActorIdRef.current
      ) {
        return;
      }

      const fetchedCandidates: any[] = Array.isArray(data.candidates) ? data.candidates : [];
      const serverLimit = typeof data.limit === 'number' ? data.limit : 50;
      const nextRawServerOffset = nextOffset + serverLimit;
      const serverHasMore = Boolean(data.has_more);

      // Deterministically compute progress against targetWarning.candidates
      const existingCandidateIds = new Set(targetWarning.candidates.map((c: any) => c.id));
      const newlyAddedCount = fetchedCandidates.filter((c: any) => !existingCandidateIds.has(c.id)).length;
      const hadNoProgress = serverHasMore && (fetchedCandidates.length === 0 || newlyAddedCount === 0);

      setWarnings((prev) => {
        const idx = prev.findIndex((w) => w.item_key === itemKey && w.field === field);
        if (idx === -1) return prev;
        const currentW = prev[idx];
        const merged = [...currentW.candidates, ...fetchedCandidates];
        const unique = Array.from(new Map(merged.map((c: any) => [c.id, c])).values());

        const copy = [...prev];
        copy[idx] = {
          ...currentW,
          candidates: unique,
          total_count: typeof data.total_count === 'number' ? data.total_count : currentW.total_count,
          has_more: serverHasMore, // Truthful server has_more preserved!
          offset: typeof data.offset === 'number' ? data.offset : nextOffset,
          raw_next_offset: nextRawServerOffset,
        };
        return copy;
      });

      if (hadNoProgress) {
        setErrorMessage('ไม่พบข้อมูลรายการซ้ำเพิ่มเติมจากเซิร์ฟเวอร์ (หน้าซ้ำ) กรุณากดลองโหลดใหม่อีกครั้ง');
      } else {
        setErrorMessage(null);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      if (
        isMountedRef.current &&
        currentGen === loadMoreGenRef.current &&
        targetActorId === currentActorIdRef.current
      ) {
        setErrorMessage('เกิดข้อผิดพลาดในการเชื่อมต่อเพื่อโหลดข้อมูลซ้ำเพิ่มเติม กรุณาลองใหม่อีกครั้ง');
      }
    } finally {
      if (
        isMountedRef.current &&
        currentGen === loadMoreGenRef.current &&
        targetActorId === currentActorIdRef.current
      ) {
        setLoadingMoreKey(null);
      }
    }
  };

  const handleResetForAnotherBatch = () => {
    setSuccessResult(null);
    setWarnings([]);
    setErrorMessage(null);
    setExplicitContinuation(false);
    setUncertainSnapshot(null);
    setRetryToken(crypto.randomUUID());
    setItems([
      {
        item_key: crypto.randomUUID(),
        name: '',
        asset_number: '',
        serial_number: '',
        source_reference: '',
        source_notes: '',
        is_legacy: false,
      },
    ]);
  };

  if (isLoadingSession) {
    return (
      <main
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#f3f4f6',
        }}
      >
        <p id="initial-loading-indicator" style={{ color: '#4b5563' }}>
          กำลังตรวจสอบสิทธิ์...
        </p>
      </main>
    );
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        backgroundColor: '#f3f4f6',
        padding: '2rem 1rem',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      }}
    >
      <div
        style={{
          maxWidth: '1100px',
          margin: '0 auto',
          backgroundColor: '#ffffff',
          borderRadius: '8px',
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)',
          padding: '2rem',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '1.5rem',
            flexWrap: 'wrap',
            gap: '1rem',
          }}
        >
          <div>
            <Link
              to="/dashboard"
              id="back-to-dashboard-link"
              style={{
                color: '#2563eb',
                textDecoration: 'none',
                fontSize: '0.875rem',
                display: 'inline-flex',
                alignItems: 'center',
                marginBottom: '0.5rem',
              }}
            >
              ← กลับไปยังแดชบอร์ด
            </Link>
            <h1
              id="bulk-register-heading"
              style={{ fontSize: '1.5rem', fontWeight: 600, margin: 0, color: '#111827' }}
            >
              ลงทะเบียนครุภัณฑ์แบบกลุ่ม (Bulk Registration)
            </h1>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {isVerifyingSession && (
              <span
                id="verifying-session-indicator"
                style={{
                  fontSize: '0.8125rem',
                  color: '#b45309',
                  backgroundColor: '#fef3c7',
                  padding: '0.25rem 0.5rem',
                  borderRadius: '4px',
                }}
              >
                กำลังตรวจสอบสิทธิ์...
              </span>
            )}
            <span
              style={{
                fontSize: '0.8125rem',
                color: '#6b7280',
                backgroundColor: '#f3f4f6',
                padding: '0.25rem 0.5rem',
                borderRadius: '4px',
              }}
            >
              จำนวนรายการ: {items.length} / 100
            </span>
          </div>
        </div>

        {forbiddenError && (
          <div
            role="alert"
            id="forbidden-alert"
            style={{
              padding: '1rem',
              borderRadius: '6px',
              backgroundColor: '#fee2e2',
              border: '1px solid #ef4444',
              color: '#991b1b',
              fontSize: '0.875rem',
              marginBottom: '1.5rem',
            }}
          >
            {forbiddenError}
          </div>
        )}

        {errorMessage && (
          <div
            role="alert"
            id="bulk-error-message"
            style={{
              padding: '1rem',
              borderRadius: '6px',
              backgroundColor: '#fee2e2',
              border: '1px solid #ef4444',
              color: '#991b1b',
              fontSize: '0.875rem',
              marginBottom: '1.5rem',
            }}
          >
            {errorMessage}
          </div>
        )}

        {/* Uncertain State Banner & Recovery Controls (F2) */}
        {!isVerifyingSession && !forbiddenError && uncertainSnapshot && (
          <div
            role="alert"
            id="uncertain-state-alert"
            style={{
              padding: '1.25rem',
              borderRadius: '6px',
              backgroundColor: '#fffbeb',
              border: '1px solid #f59e0b',
              color: '#92400e',
              fontSize: '0.875rem',
              marginBottom: '1.5rem',
            }}
          >
            <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1rem', fontWeight: 600, color: '#b45309' }}>
              ⚠️ สถานะการส่งไม่แน่ชัด (Uncertain Submission Outcome)
            </h3>
            <p style={{ margin: '0 0 1rem 0' }}>
              คำขอถูกส่งไปยังเซิร์ฟเวอร์แล้วแต่ไม่ได้รับผลลัพธ์ที่แน่ชัด ระบบได้ล็อกแบบฟอร์มไว้เพื่อความปลอดภัย หากเซิร์ฟเวอร์ได้บันทึกข้อมูลไปแล้ว การกด "ลองส่งใหม่อีกครั้งด้วยข้อมูลเดิม" จะดึงผลลัพธ์เดิมกลับมาโดยไม่สร้างรายการซ้ำ หากเลือก "ละทิ้งการกู้คืนเฉพาะในเครื่องและเริ่มกรอกชุดใหม่" จะเป็นการยกเลิกสถานะกู้คืนเฉพาะในเบราว์เซอร์เท่านั้น และไม่สามารถยกเลิกรายการที่อาจถูกบันทึกบนเซิร์ฟเวอร์ไปแล้วได้
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                id="retry-uncertain-btn"
                onClick={handleRetryUncertain}
                disabled={isSubmitting || isVerifyingSession || Boolean(forbiddenError)}
                style={{
                  padding: '0.5rem 1rem',
                  backgroundColor: '#2563eb',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '4px',
                  fontWeight: 600,
                  fontSize: '0.875rem',
                  cursor: isSubmitting || isVerifyingSession || Boolean(forbiddenError) ? 'not-allowed' : 'pointer',
                }}
              >
                {isSubmitting ? 'กำลังส่งข้อมูลเดิม...' : 'ลองส่งใหม่อีกครั้งด้วยข้อมูลเดิม'}
              </button>
              <button
                type="button"
                id="discard-uncertain-btn"
                onClick={handleDiscardUncertain}
                disabled={isSubmitting || isVerifyingSession || Boolean(forbiddenError)}
                style={{
                  padding: '0.5rem 1rem',
                  backgroundColor: '#f3f4f6',
                  color: '#4b5563',
                  border: '1px solid #d1d5db',
                  borderRadius: '4px',
                  fontWeight: 500,
                  fontSize: '0.875rem',
                  cursor: isSubmitting || isVerifyingSession || Boolean(forbiddenError) ? 'not-allowed' : 'pointer',
                }}
              >
                ละทิ้งการกู้คืนเฉพาะในเครื่องและเริ่มกรอกชุดใหม่
              </button>
            </div>
          </div>
        )}

        {/* Success View */}
        {!isVerifyingSession && !forbiddenError && successResult ? (
          <section
            id="bulk-register-success"
            aria-labelledby="success-heading"
            style={{
              backgroundColor: '#ecfdf5',
              border: '1px solid #10b981',
              borderRadius: '6px',
              padding: '1.5rem',
            }}
          >
            <h2
              id="success-heading"
              style={{ fontSize: '1.25rem', fontWeight: 600, color: '#065f46', margin: '0 0 0.5rem 0' }}
            >
              ✓ ลงทะเบียนครุภัณฑ์แบบกลุ่มสำเร็จ
            </h2>
            <p style={{ margin: '0 0 1rem 0', color: '#047857', fontSize: '0.9375rem' }}>
              ลงทะเบียนครุภัณฑ์เรียบร้อยแล้วทั้งหมด{' '}
              <strong id="total-registered-count">{successResult.total_registered}</strong> รายการ
              {successResult.shared_acquisition_id && (
                <span>
                  {' '}
                  (เชื่อมโยงกับการได้มา:{' '}
                  <Link
                    to={`/acquisitions/${successResult.shared_acquisition_id}`}
                    id="linked-acquisition-link"
                    style={{ color: '#059669', textDecoration: 'underline' }}
                  >
                    {successResult.shared_acquisition_id}
                  </Link>
                  )
                </span>
              )}
            </p>

            <h3 style={{ fontSize: '1rem', fontWeight: 600, color: '#065f46', margin: '1rem 0 0.5rem 0' }}>
              รายการครุภัณฑ์ที่บันทึกแล้ว:
            </h3>
            <div style={{ overflowX: 'auto', marginBottom: '1.5rem' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                <thead>
                  <tr style={{ backgroundColor: '#d1fae5', textAlign: 'left', borderBottom: '1px solid #a7f3d0' }}>
                    <th style={{ padding: '0.5rem 0.75rem' }}>ลำดับ</th>
                    <th style={{ padding: '0.5rem 0.75rem' }}>รหัสครุภัณฑ์ (Stable ID)</th>
                    <th style={{ padding: '0.5rem 0.75rem' }}>การดำเนินการ</th>
                  </tr>
                </thead>
                <tbody>
                  {successResult.results.map((res, i) => (
                    <tr key={res.item_key} style={{ borderBottom: '1px solid #e5e7eb' }}>
                      <td style={{ padding: '0.5rem 0.75rem' }}>{i + 1}</td>
                      <td style={{ padding: '0.5rem 0.75rem', fontFamily: 'monospace' }}>{res.asset_id}</td>
                      <td style={{ padding: '0.5rem 0.75rem' }}>
                        <Link
                          to={`/assets/${res.asset_id}`}
                          id={`registered-asset-link-${i}`}
                          style={{ color: '#2563eb', textDecoration: 'underline' }}
                        >
                          ดูรายละเอียด →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', gap: '1rem' }}>
              <button
                type="button"
                id="register-another-bulk-btn"
                onClick={handleResetForAnotherBatch}
                style={{
                  padding: '0.5rem 1rem',
                  backgroundColor: '#059669',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '4px',
                  fontWeight: 500,
                  fontSize: '0.875rem',
                  cursor: 'pointer',
                }}
              >
                + ลงทะเบียนแบบกลุ่มชุดใหม่
              </button>
            </div>
          </section>
        ) : (
          /* Input Form */
          <form onSubmit={handleSubmit} noValidate>
            {/* Shared Acquisition Input */}
            <div
              style={{
                backgroundColor: '#f9fafb',
                padding: '1rem 1.25rem',
                borderRadius: '6px',
                marginBottom: '1.5rem',
                border: '1px solid #e5e7eb',
              }}
            >
              <label
                htmlFor="shared-acquisition-id"
                style={{
                  display: 'block',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  color: '#374151',
                  marginBottom: '0.25rem',
                }}
              >
                รหัสอ้างอิงการได้มาร่วม (Shared Acquisition Reference - ไม่บังคับ):
              </label>
              <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.8125rem', color: '#6b7280' }}>
                หากระบุ ครุภัณฑ์ทุกชิ้นในชุดนี้จะถูกเชื่อมโยงกับการได้มานี้โดยอัตโนมัติ
              </p>
              <input
                type="text"
                id="shared-acquisition-id"
                value={sharedAcquisitionId}
                onChange={(e) => handleSharedAcquisitionChange(e.target.value)}
                disabled={Boolean(uncertainSnapshot) || isSubmitting || isVerifyingSession || Boolean(forbiddenError)}
                placeholder="เช่น 12345678-1234-4234-8234-123456789abc"
                style={{
                  width: '100%',
                  maxWidth: '500px',
                  padding: '0.5rem 0.75rem',
                  fontSize: '0.875rem',
                  borderRadius: '4px',
                  border: '1px solid #d1d5db',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Row-Correlated Candidate Warnings Alert (F1, F4) */}
            {!isVerifyingSession && !forbiddenError && warnings.length > 0 && (
              <div
                role="alert"
                id="duplicate-warnings-banner"
                style={{
                  padding: '1.25rem',
                  borderRadius: '6px',
                  backgroundColor: '#fffbeb',
                  border: '1px solid #f59e0b',
                  color: '#92400e',
                  fontSize: '0.875rem',
                  marginBottom: '1.5rem',
                }}
              >
                <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1rem', fontWeight: 600, color: '#b45309' }}>
                  ⚠️ ตรวจพบข้อมูลซ้ำ ({warnings.length} จุดที่ตรงกัน)
                </h3>
                <p style={{ margin: '0 0 0.75rem 0' }}>
                  ระบบพบว่ามีเลขครุภัณฑ์หรือหมายเลขซีเรียลที่ตรงกับข้อมูลในระบบหรือซ้ำกันภายในชุดข้อมูล:
                </p>

                <div id="duplicate-warning-list" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1rem' }}>
                  {warnings.map((w, idx) => {
                    const itemIndex = items.findIndex((it) => it.item_key === w.item_key);
                    const rowLabel =
                      itemIndex >= 0
                        ? `รายการที่ ${itemIndex + 1}${items[itemIndex]?.name ? ` (${items[itemIndex].name})` : ''}`
                        : `รหัส ${w.item_key}`;

                    const otherRowNums = (w.intra_batch_keys || [])
                      .map((k) => items.findIndex((it) => it.item_key === k) + 1)
                      .filter((n) => n > 0);

                    return (
                      <div
                        key={`${w.item_key}-${w.field}-${idx}`}
                        id={`duplicate-warning-item-${idx}`}
                        style={{
                          backgroundColor: '#ffffff',
                          border: '1px solid #fcd34d',
                          borderRadius: '6px',
                          padding: '0.75rem 1rem',
                        }}
                      >
                        <div style={{ fontWeight: 600, color: '#92400e', marginBottom: '0.25rem' }}>
                          {rowLabel} — {w.field === 'asset_number' ? 'เลขครุภัณฑ์' : 'หมายเลขซีเรียล'}:{' '}
                          <code style={{ backgroundColor: '#fef3c7', padding: '0.125rem 0.375rem', borderRadius: '3px' }}>
                            {w.value}
                          </code>
                        </div>

                        {w.intra_batch ? (
                          <p style={{ margin: '0.25rem 0', color: '#b45309' }}>
                            ซ้ำกับรายการอื่นในชุดข้อมูลนี้:{' '}
                            <strong>{otherRowNums.length > 0 ? otherRowNums.map((n) => `รายการที่ ${n}`).join(', ') : 'รายการอื่น'}</strong>
                          </p>
                        ) : (
                          <div>
                            <p style={{ margin: '0.25rem 0 0.5rem 0', color: '#b45309' }}>
                              ตรงกับครุภัณฑ์ที่มีอยู่แล้วในระบบทั้งหมด <strong>{w.total_count}</strong> รายการ
                              {w.has_more && ` (แสดง ${w.candidates.length} รายการแรก)`}
                            </p>

                            {w.candidates.length > 0 && (
                              <div style={{ overflowX: 'auto', marginBottom: '0.5rem' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
                                  <thead>
                                    <tr style={{ backgroundColor: '#fef3c7', textAlign: 'left', borderBottom: '1px solid #fde68a' }}>
                                      <th style={{ padding: '0.25rem 0.5rem' }}>เลขครุภัณฑ์</th>
                                      <th style={{ padding: '0.25rem 0.5rem' }}>ซีเรียล</th>
                                      <th style={{ padding: '0.25rem 0.5rem' }}>ชื่อครุภัณฑ์</th>
                                      <th style={{ padding: '0.25rem 0.5rem' }}>การดำเนินการ</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {w.candidates.map((c) => (
                                      <tr key={c.id} style={{ borderBottom: '1px solid #fef3c7' }}>
                                        <td style={{ padding: '0.25rem 0.5rem' }}>{c.asset_number || '-'}</td>
                                        <td style={{ padding: '0.25rem 0.5rem' }}>{c.serial_number || '-'}</td>
                                        <td style={{ padding: '0.25rem 0.5rem' }}>{c.name || '-'}</td>
                                        <td style={{ padding: '0.25rem 0.5rem' }}>
                                          <Link
                                            to={`/assets/${c.id}`}
                                            id={`dup-candidate-link-${c.id}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            style={{ color: '#2563eb', textDecoration: 'underline' }}
                                          >
                                            ดูรายละเอียด ({c.id.substring(0, 8)}...)
                                          </Link>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}

                            {w.has_more && (
                              <button
                                type="button"
                                id={`load-more-candidates-btn-${idx}`}
                                onClick={() => handleLoadMoreCandidates(w.item_key, w.field)}
                                disabled={
                                  loadingMoreKey === `${w.item_key}:${w.field}` ||
                                  isSubmitting ||
                                  isVerifyingSession ||
                                  Boolean(forbiddenError) ||
                                  Boolean(uncertainSnapshot)
                                }
                                style={{
                                  padding: '0.25rem 0.5rem',
                                  fontSize: '0.75rem',
                                  backgroundColor: '#fef3c7',
                                  border: '1px solid #f59e0b',
                                  borderRadius: '3px',
                                  color: '#92400e',
                                  cursor:
                                    loadingMoreKey === `${w.item_key}:${w.field}` ||
                                    isSubmitting ||
                                    isVerifyingSession ||
                                    Boolean(forbiddenError) ||
                                    Boolean(uncertainSnapshot)
                                      ? 'not-allowed'
                                      : 'pointer',
                                  fontWeight: 500,
                                }}
                              >
                                {loadingMoreKey === `${w.item_key}:${w.field}`
                                  ? 'กำลังโหลด...'
                                  : `โหลดรายการเพิ่มเติม (${w.candidates.length}/${w.total_count})`}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                <label
                  htmlFor="explicit-continuation-checkbox"
                  style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 500, cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    id="explicit-continuation-checkbox"
                    checked={explicitContinuation}
                    onChange={(e) => setExplicitContinuation(e.target.checked)}
                    disabled={Boolean(uncertainSnapshot) || isSubmitting || isVerifyingSession || Boolean(forbiddenError)}
                  />
                  ยืนยันการลงทะเบียนเป็นครุภัณฑ์ชิ้นใหม่ต่างหาก แม้จะมีเลขครุภัณฑ์หรือซีเรียลซ้ำ
                </label>
              </div>
            )}

            {/* Items Table */}
            <div style={{ overflowX: 'auto', marginBottom: '1.5rem' }}>
              <table id="bulk-items-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                <thead>
                  <tr style={{ backgroundColor: '#f9fafb', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>
                    <th style={{ padding: '0.5rem', width: '40px' }}>#</th>
                    <th style={{ padding: '0.5rem', minWidth: '180px' }}>ชื่อครุภัณฑ์ *</th>
                    <th style={{ padding: '0.5rem', minWidth: '140px' }}>เลขครุภัณฑ์</th>
                    <th style={{ padding: '0.5rem', minWidth: '140px' }}>ซีเรียล (S/N)</th>
                    <th style={{ padding: '0.5rem', minWidth: '130px' }}>เอกสาร/แหล่งที่มา</th>
                    <th style={{ padding: '0.5rem', width: '80px', textAlign: 'center' }}>ข้อมูลเก่า</th>
                    <th style={{ padding: '0.5rem', width: '60px', textAlign: 'center' }}>ลบ</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, idx) => (
                    <tr key={item.item_key} id={`bulk-item-row-${idx}`} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '0.5rem', verticalAlign: 'top', paddingTop: '0.75rem' }}>{idx + 1}</td>
                      <td style={{ padding: '0.5rem' }}>
                        <input
                          type="text"
                          id={`item-name-${idx}`}
                          value={item.name}
                          onChange={(e) => handleItemChange(idx, 'name', e.target.value)}
                          disabled={Boolean(uncertainSnapshot) || isSubmitting || isVerifyingSession || Boolean(forbiddenError)}
                          placeholder={item.is_legacy ? 'ไม่ระบุได้' : 'จำเป็นต้องระบุ'}
                          style={{
                            width: '100%',
                            padding: '0.375rem 0.5rem',
                            fontSize: '0.875rem',
                            borderRadius: '4px',
                            border: '1px solid #d1d5db',
                            boxSizing: 'border-box',
                          }}
                        />
                      </td>
                      <td style={{ padding: '0.5rem' }}>
                        <input
                          type="text"
                          id={`item-asset-number-${idx}`}
                          value={item.asset_number}
                          onChange={(e) => handleItemChange(idx, 'asset_number', e.target.value)}
                          disabled={Boolean(uncertainSnapshot) || isSubmitting || isVerifyingSession || Boolean(forbiddenError)}
                          placeholder="เช่น AST-2026-001"
                          style={{
                            width: '100%',
                            padding: '0.375rem 0.5rem',
                            fontSize: '0.875rem',
                            borderRadius: '4px',
                            border: '1px solid #d1d5db',
                            boxSizing: 'border-box',
                          }}
                        />
                      </td>
                      <td style={{ padding: '0.5rem' }}>
                        <input
                          type="text"
                          id={`item-serial-number-${idx}`}
                          value={item.serial_number}
                          onChange={(e) => handleItemChange(idx, 'serial_number', e.target.value)}
                          disabled={Boolean(uncertainSnapshot) || isSubmitting || isVerifyingSession || Boolean(forbiddenError)}
                          placeholder="เช่น SN-ABC123"
                          style={{
                            width: '100%',
                            padding: '0.375rem 0.5rem',
                            fontSize: '0.875rem',
                            borderRadius: '4px',
                            border: '1px solid #d1d5db',
                            boxSizing: 'border-box',
                          }}
                        />
                      </td>
                      <td style={{ padding: '0.5rem' }}>
                        <input
                          type="text"
                          id={`item-source-ref-${idx}`}
                          value={item.source_reference}
                          onChange={(e) => handleItemChange(idx, 'source_reference', e.target.value)}
                          disabled={Boolean(uncertainSnapshot) || isSubmitting || isVerifyingSession || Boolean(forbiddenError)}
                          placeholder="เช่น PO-88"
                          style={{
                            width: '100%',
                            padding: '0.375rem 0.5rem',
                            fontSize: '0.875rem',
                            borderRadius: '4px',
                            border: '1px solid #d1d5db',
                            boxSizing: 'border-box',
                          }}
                        />
                      </td>
                      <td style={{ padding: '0.5rem', textAlign: 'center', verticalAlign: 'middle' }}>
                        <input
                          type="checkbox"
                          id={`item-legacy-${idx}`}
                          checked={item.is_legacy}
                          onChange={(e) => handleItemChange(idx, 'is_legacy', e.target.checked)}
                          disabled={Boolean(uncertainSnapshot) || isSubmitting || isVerifyingSession || Boolean(forbiddenError)}
                        />
                      </td>
                      <td style={{ padding: '0.5rem', textAlign: 'center', verticalAlign: 'middle' }}>
                        {items.length > 1 && (
                          <button
                            type="button"
                            id={`item-remove-btn-${idx}`}
                            onClick={() => handleRemoveItem(idx)}
                            disabled={Boolean(uncertainSnapshot) || isSubmitting || isVerifyingSession || Boolean(forbiddenError)}
                            style={{
                              backgroundColor: 'transparent',
                              border: 'none',
                              color: '#ef4444',
                              cursor: Boolean(uncertainSnapshot) || isSubmitting || isVerifyingSession || Boolean(forbiddenError) ? 'not-allowed' : 'pointer',
                              fontWeight: 'bold',
                              fontSize: '1rem',
                            }}
                            title="ลบรายการนี้"
                          >
                            ×
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '1rem',
                marginTop: '1rem',
              }}
            >
              <button
                type="button"
                id="add-row-btn"
                onClick={handleAddItem}
                disabled={items.length >= 100 || Boolean(uncertainSnapshot) || isSubmitting || isVerifyingSession || Boolean(forbiddenError)}
                style={{
                  padding: '0.5rem 1rem',
                  backgroundColor: '#f3f4f6',
                  color: '#374151',
                  border: '1px solid #d1d5db',
                  borderRadius: '4px',
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  cursor: items.length >= 100 || Boolean(uncertainSnapshot) || isSubmitting || isVerifyingSession || Boolean(forbiddenError) ? 'not-allowed' : 'pointer',
                }}
              >
                + เพิ่มรายการ ({items.length}/100)
              </button>

              <button
                type="submit"
                id="submit-bulk-register-btn"
                disabled={Boolean(uncertainSnapshot) || isSubmitting || isVerifyingSession || Boolean(forbiddenError)}
                style={{
                  padding: '0.625rem 1.5rem',
                  backgroundColor: isSubmitting || isVerifyingSession || Boolean(uncertainSnapshot) || Boolean(forbiddenError) ? '#9ca3af' : '#2563eb',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '4px',
                  fontSize: '0.9375rem',
                  fontWeight: 600,
                  cursor: isSubmitting || isVerifyingSession || Boolean(uncertainSnapshot) || Boolean(forbiddenError) ? 'not-allowed' : 'pointer',
                }}
              >
                {isSubmitting
                  ? 'กำลังบันทึกข้อมูล...'
                  : isVerifyingSession
                  ? 'กำลังตรวจสอบสิทธิ์...'
                  : `บันทึกการลงทะเบียนแบบกลุ่ม (${items.length} รายการ)`}
              </button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
};

export default AssetBulkRegister;
