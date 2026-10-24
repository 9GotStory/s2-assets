import React, { useState, useRef, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type { AssetRecord } from '../pages/AssetDetail';

export interface AssetCorrectionFormProps {
  asset: AssetRecord;
  isLegacy?: boolean;
  csrfToken?: string | null;
  onSuccess: (updatedAsset: AssetRecord) => Promise<boolean> | boolean | void;
  onCancel?: () => void;
  onPermissionRevoked?: () => void;
}

interface FormValues {
  name: string;
  asset_number: string;
  serial_number: string;
  reason: string;
  explicit_continuation: boolean;
}

interface DuplicateCandidate {
  id: string;
  name: string | null;
  asset_number: string | null;
  serial_number: string | null;
}

export const AssetCorrectionForm: React.FC<AssetCorrectionFormProps> = ({
  asset,
  isLegacy = false,
  csrfToken,
  onSuccess,
  onCancel,
  onPermissionRevoked,
}) => {
  const retryTokenRef = useRef<string>(crypto.randomUUID());

  // Baseline expected-before state to prevent silent rebasing during edits
  const [baselineExpected, setBaselineExpected] = useState({
    name: asset.name,
    asset_number: asset.asset_number,
    serial_number: asset.serial_number,
  });

  const [candidates, setCandidates] = useState<DuplicateCandidate[]>([]);
  const [totalCandidateCount, setTotalCandidateCount] = useState<number>(0);
  const [hasMoreCandidates, setHasMoreCandidates] = useState<boolean>(false);
  const [isCheckingDuplicates, setIsCheckingDuplicates] = useState(false);
  const [isLoadingMoreCandidates, setIsLoadingMoreCandidates] = useState(false);
  const [duplicateCheckError, setDuplicateCheckError] = useState<string | null>(null);

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPendingUncertain, setIsPendingUncertain] = useState(false);
  const [isCommittedAwaitingRefresh, setIsCommittedAwaitingRefresh] = useState(false);

  // Stored frozen payload for uncertain retry
  const frozenPayloadRef = useRef<{
    name: string | null;
    asset_number: string | null;
    serial_number: string | null;
    expected_name: string | null;
    expected_asset_number: string | null;
    expected_serial_number: string | null;
    reason: string | null;
    explicit_continuation: boolean;
    retry_token: string;
  } | null>(null);

  // Sequence tracking and AbortControllers
  const lookupSeqRef = useRef<number>(0);
  const lookupAbortRef = useRef<AbortController | null>(null);
  const submitSeqRef = useRef<number>(0);
  const submitAbortRef = useRef<AbortController | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    watch,
    setValue,
    reset,
    formState,
  } = useForm<FormValues>({
    defaultValues: {
      name: asset.name || '',
      asset_number: asset.asset_number || '',
      serial_number: asset.serial_number || '',
      reason: '',
      explicit_continuation: false,
    },
  });

  const { errors, isDirty } = formState;

  const lastReconciledRef = useRef({
    name: asset.name,
    asset_number: asset.asset_number,
    serial_number: asset.serial_number,
    updated_at: asset.updated_at,
  });

  // Rebase baseline only when asset props from parent actually change/refetch
  useEffect(() => {
    const isAssetChanged =
      asset.updated_at !== lastReconciledRef.current.updated_at ||
      asset.name !== lastReconciledRef.current.name ||
      asset.asset_number !== lastReconciledRef.current.asset_number ||
      asset.serial_number !== lastReconciledRef.current.serial_number;

    if (isAssetChanged) {
      lastReconciledRef.current = {
        name: asset.name,
        asset_number: asset.asset_number,
        serial_number: asset.serial_number,
        updated_at: asset.updated_at,
      };

      setBaselineExpected({
        name: asset.name,
        asset_number: asset.asset_number,
        serial_number: asset.serial_number,
      });

      if (!isDirty || isCommittedAwaitingRefresh) {
        reset({
          name: asset.name || '',
          asset_number: asset.asset_number || '',
          serial_number: asset.serial_number || '',
          reason: '',
          explicit_continuation: false,
        });
      }

      if (isCommittedAwaitingRefresh) {
        setIsCommittedAwaitingRefresh(false);
        setSuccessMessage('บันทึกการแก้ไขครุภัณฑ์สำเร็จ');
        setSubmitError(null);
        retryTokenRef.current = crypto.randomUUID(); // Fresh new token for next intent
        setCandidates([]);
        setTotalCandidateCount(0);
        setHasMoreCandidates(false);
      }
    }
  }, [
    asset.name,
    asset.asset_number,
    asset.serial_number,
    asset.updated_at,
    isDirty,
    isCommittedAwaitingRefresh,
    reset,
  ]);

  // Cleanup abort controllers on unmount
  useEffect(() => {
    return () => {
      if (lookupAbortRef.current) {
        lookupAbortRef.current.abort();
      }
      if (submitAbortRef.current) {
        submitAbortRef.current.abort();
      }
    };
  }, []);

  const watchedAssetNumber = watch('asset_number');
  const watchedSerialNumber = watch('serial_number');

  // When identifier fields change, reset duplicate candidate warning and explicit continuation
  const handleIdentifierChange = (field: 'asset_number' | 'serial_number', val: string) => {
    if (isPendingUncertain || isCommittedAwaitingRefresh) return;
    setValue(field, val, { shouldDirty: true });
    lookupSeqRef.current += 1;
    submitSeqRef.current += 1; // Invalidate any in-flight POST submission warnings
    if (lookupAbortRef.current) {
      lookupAbortRef.current.abort();
      lookupAbortRef.current = null;
    }
    if (submitAbortRef.current) {
      submitAbortRef.current.abort();
      submitAbortRef.current = null;
    }
    setIsCheckingDuplicates(false);
    setIsLoadingMoreCandidates(false);
    setIsSubmitting(false);
    setCandidates([]);
    setTotalCandidateCount(0);
    setHasMoreCandidates(false);
    setDuplicateCheckError(null);
    setValue('explicit_continuation', false);
  };

  // Duplicate candidates preview
  const handleCheckDuplicates = async (offsetToFetch = 0, isAppend = false) => {
    const curAssetNumber = watchedAssetNumber || '';
    const curSerialNumber = watchedSerialNumber || '';

    if (!curAssetNumber && !curSerialNumber) {
      setIsCheckingDuplicates(false);
      setIsLoadingMoreCandidates(false);
      setCandidates([]);
      setTotalCandidateCount(0);
      setHasMoreCandidates(false);
      return;
    }

    lookupSeqRef.current += 1;
    const currentSeq = lookupSeqRef.current;
    if (lookupAbortRef.current) {
      lookupAbortRef.current.abort();
    }
    const controller = new AbortController();
    lookupAbortRef.current = controller;

    if (isAppend) {
      setIsLoadingMoreCandidates(true);
    } else {
      setIsCheckingDuplicates(true);
    }
    setDuplicateCheckError(null);

    try {
      const params = new URLSearchParams();
      if (curAssetNumber) params.append('asset_number', curAssetNumber);
      if (curSerialNumber) params.append('serial_number', curSerialNumber);
      params.append('limit', '10');
      params.append('offset', String(offsetToFetch));

      const res = await fetch(`/assets/${asset.id}/duplicate-candidates?${params.toString()}`, {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal,
      });

      if (currentSeq !== lookupSeqRef.current) return;

      if (res.status === 403) {
        setDuplicateCheckError('คุณไม่มีสิทธิ์ตรวจสอบข้อมูลซ้ำ (403 Forbidden)');
        onPermissionRevoked?.();
        setIsCheckingDuplicates(false);
        setIsLoadingMoreCandidates(false);
        return;
      }

      if (!res.ok) {
        setDuplicateCheckError('ไม่สามารถตรวจสอบข้อมูลซ้ำได้');
        setIsCheckingDuplicates(false);
        setIsLoadingMoreCandidates(false);
        return;
      }

      const data = await res.json();
      if (currentSeq !== lookupSeqRef.current) return;

      const fetchedCandidates: DuplicateCandidate[] = data.candidates || [];
      const existingIds = new Set(candidates.map((c) => c.id));
      const newUnique = fetchedCandidates.filter((c) => !existingIds.has(c.id));
      const updatedCandidates = isAppend ? [...candidates, ...newUnique] : fetchedCandidates;
      setCandidates(updatedCandidates);
      setTotalCandidateCount(
        typeof data.total_count === 'number' ? data.total_count : updatedCandidates.length
      );
      setHasMoreCandidates(Boolean(data.has_more));

      if (updatedCandidates.length === 0) {
        setValue('explicit_continuation', false);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (currentSeq !== lookupSeqRef.current) return;
      setDuplicateCheckError('เกิดข้อผิดพลาดในการเชื่อมต่อเพื่อตรวจสอบข้อมูลซ้ำ');
    } finally {
      if (currentSeq === lookupSeqRef.current) {
        setIsCheckingDuplicates(false);
        setIsLoadingMoreCandidates(false);
      }
    }
  };

  const executeSubmission = async (payload: {
    name: string | null;
    asset_number: string | null;
    serial_number: string | null;
    expected_name: string | null;
    expected_asset_number: string | null;
    expected_serial_number: string | null;
    reason: string | null;
    explicit_continuation: boolean;
    retry_token: string;
  }) => {
    submitSeqRef.current += 1;
    const currentSubmitSeq = submitSeqRef.current;
    if (submitAbortRef.current) {
      submitAbortRef.current.abort();
    }
    const controller = new AbortController();
    submitAbortRef.current = controller;

    setIsSubmitting(true);
    setSubmitError(null);
    setSuccessMessage(null);

    // Save frozen payload in ref in case of network/transport uncertainty
    frozenPayloadRef.current = payload;

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-retry-token': payload.retry_token,
      };
      if (csrfToken) {
        headers['x-csrf-token'] = csrfToken;
      }

      const res = await fetch(`/assets/${asset.id}/correct`, {
        method: 'POST',
        headers,
        credentials: 'include',
        signal: controller.signal,
        body: JSON.stringify(payload),
      });

      if (currentSubmitSeq !== submitSeqRef.current) return;

      if (res.status === 409) {
        const errJson = await res.json().catch(() => null);
        setIsPendingUncertain(false);
        if (errJson?.code === 'STALE_BEFORE_CONFLICT') {
          setSubmitError(
            'ข้อมูลครุภัณฑ์ถูกแก้ไขโดยผู้อื่นแล้ว กรุณารีเฟรชข้อมูลล่าสุดก่อนดำเนินการต่อ (409 Conflict)'
          );
        } else if (
          errJson?.code === 'DUPLICATE_WARNING' ||
          errJson?.code === 'DUPLICATE_CANDIDATES_FOUND'
        ) {
          setCandidates(errJson.candidates || []);
          setTotalCandidateCount(errJson.total_count ?? (errJson.candidates?.length || 0));
          setHasMoreCandidates(Boolean(errJson.has_more));
          setSubmitError(
            'พบข้อมูลครุภัณฑ์ใกล้เคียงกันในระบบ หากประสงค์จะบันทึกข้อมูลนี้ กรุณาทำเครื่องหมายยืนยันด้านล่าง'
          );
        } else {
          setSubmitError(errJson?.message || 'เกิดข้อขัดแย้งของข้อมูล (409 Conflict)');
        }
        setIsSubmitting(false);
        return;
      }

      if (res.status === 400) {
        setIsPendingUncertain(false);
        const errJson = await res.json().catch(() => null);
        setSubmitError(errJson?.message || 'ข้อมูลที่ส่งไม่ถูกต้อง (400 Bad Request)');
        setIsSubmitting(false);
        return;
      }

      if (res.status === 403) {
        setIsPendingUncertain(false);
        setSubmitError('คุณไม่มีสิทธิ์แก้ไขข้อมูลครุภัณฑ์นี้ (403 Forbidden)');
        onPermissionRevoked?.();
        setIsSubmitting(false);
        return;
      }

      if (!res.ok) {
        // Transport or server error (>= 500): Server state uncertain, FREEZE intent and offer retry with same token
        setIsPendingUncertain(true);
        setSubmitError('เกิดข้อผิดพลาดในการบันทึกข้อมูล กรุณากดบันทึกซ้ำเพื่อดำเนินการต่อได้อย่างปลอดภัย');
        setIsSubmitting(false);
        return;
      }

      const result = await res.json();
      if (currentSubmitSeq !== submitSeqRef.current) return;

      // Commit confirmed on server!
      // Now verify refresh first:
      let refreshSuccess = true;
      if (result?.asset) {
        const refreshRes = await onSuccess(result.asset);
        if (refreshRes === false) {
          refreshSuccess = false;
        }
      }

      if (!refreshSuccess) {
        // Refresh failed: lock form in COMMITTED_AWAITING_REFRESH, keep committed token, do not allow edits
        setIsSubmitting(false);
        setIsPendingUncertain(false);
        setIsCommittedAwaitingRefresh(true);
        setSubmitError(
          'บันทึกการแก้ไขครุภัณฑ์สำเร็จ แต่การดึงข้อมูลล่าสุดล้มเหลว กรุณากดปุ่มเพื่อโหลดข้อมูลใหม่'
        );
        return;
      }

      // Both commit and refresh succeeded!
      setSuccessMessage('บันทึกการแก้ไขครุภัณฑ์สำเร็จ');
      setIsPendingUncertain(false);
      frozenPayloadRef.current = null;
      retryTokenRef.current = crypto.randomUUID();
      setIsSubmitting(false);

      if (result?.asset) {
        setBaselineExpected({
          name: result.asset.name,
          asset_number: result.asset.asset_number,
          serial_number: result.asset.serial_number,
        });
        reset({
          name: result.asset.name || '',
          asset_number: result.asset.asset_number || '',
          serial_number: result.asset.serial_number || '',
          reason: '',
          explicit_continuation: false,
        });
        setCandidates([]);
        setTotalCandidateCount(0);
        setHasMoreCandidates(false);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setIsSubmitting(false);
        return;
      }
      if (currentSubmitSeq !== submitSeqRef.current) return;
      // Network failure: State uncertain, freeze intent, keep retry token unchanged
      setIsPendingUncertain(true);
      setSubmitError(
        'เกิดข้อผิดพลาดในการเชื่อมต่อเครือข่าย ท่านสามารถกดบันทึกซ้ำเพื่อดำเนินการต่อได้อย่างปลอดภัย'
      );
      setIsSubmitting(false);
    }
  };

  const retryUncertain = async () => {
    if (frozenPayloadRef.current) {
      await executeSubmission(frozenPayloadRef.current);
    }
  };

  const onSubmit = async (data: FormValues) => {
    if (isCommittedAwaitingRefresh) {
      return;
    }
    if (isPendingUncertain && frozenPayloadRef.current) {
      await executeSubmission(frozenPayloadRef.current);
      return;
    }

    setSubmitError(null);
    setSuccessMessage(null);

    // Retain exact nonempty identifiers verbatim without trimming
    const rawAssetNumber = data.asset_number === '' ? null : data.asset_number;
    const rawSerialNumber = data.serial_number === '' ? null : data.serial_number;
    const rawName = data.name === '' ? null : data.name;
    const trimmedReason = (data.reason || '').trim();

    // Check no-op against baseline expected
    const isNoOp =
      rawName === (baselineExpected.name ?? null) &&
      rawAssetNumber === (baselineExpected.asset_number ?? null) &&
      rawSerialNumber === (baselineExpected.serial_number ?? null);

    // 1. Zod client-side validation
    const schema = z.object({
      name: isLegacy
        ? z.string()
        : z
            .string()
            .refine((val) => val.trim().length > 0, 'กรุณาระบุชื่อหรือคำอธิบายครุภัณฑ์'),
      asset_number: z.string(),
      serial_number: z.string(),
      reason: isNoOp
        ? z.string()
        : z
            .string()
            .refine((val) => val.trim().length > 0, 'กรุณาระบุเหตุผลในการแก้ไขข้อมูลครุภัณฑ์'),
      explicit_continuation: z.boolean(),
    });

    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const fieldName = issue.path[0] as keyof FormValues;
        setError(fieldName, { type: 'manual', message: issue.message });
      }
      return;
    }

    // Check duplicate warning acknowledgement requirement
    if (candidates.length > 0 && !data.explicit_continuation) {
      setSubmitError('พบข้อมูลซ้ำในระบบ โปรดตรวจสอบและยืนยันการบันทึกการแก้ไขก่อนดำเนินการต่อ');
      return;
    }

    const payload = {
      name: isLegacy && (!rawName || rawName.trim().length === 0) ? null : rawName,
      asset_number: rawAssetNumber,
      serial_number: rawSerialNumber,
      expected_name: baselineExpected.name,
      expected_asset_number: baselineExpected.asset_number,
      expected_serial_number: baselineExpected.serial_number,
      reason: isNoOp && trimmedReason.length === 0 ? null : trimmedReason,
      explicit_continuation: data.explicit_continuation,
      retry_token: retryTokenRef.current,
    };

    await executeSubmission(payload);
  };

  const isFormDisabled = isSubmitting || isPendingUncertain || isCommittedAwaitingRefresh;

  return (
    <form
      id="asset-correction-form"
      onSubmit={handleSubmit(onSubmit)}
      style={{
        backgroundColor: '#ffffff',
        border: '1px solid #e5e7eb',
        borderRadius: '8px',
        padding: '1.5rem',
        marginTop: '1.5rem',
      }}
    >
      <h3
        style={{
          marginTop: 0,
          marginBottom: '1rem',
          fontSize: '1.125rem',
          fontWeight: 600,
          color: '#111827',
        }}
      >
        แบบฟอร์มแก้ไขข้อมูลครุภัณฑ์
      </h3>

      {/* Success alert */}
      {successMessage && (
        <div
          role="status"
          aria-live="polite"
          data-testid="correction-success-message"
          style={{
            padding: '0.75rem 1rem',
            backgroundColor: '#ecfdf5',
            color: '#065f46',
            borderRadius: '6px',
            marginBottom: '1rem',
            fontSize: '0.875rem',
            fontWeight: 500,
          }}
        >
          {successMessage}
        </div>
      )}

      {/* Committed Awaiting Refresh Banner (F-02) */}
      {isCommittedAwaitingRefresh && (
        <div
          role="alert"
          data-testid="committed-awaiting-refresh-banner"
          style={{
            padding: '0.75rem 1rem',
            backgroundColor: '#fef3c7',
            border: '1px solid #f59e0b',
            borderRadius: '6px',
            color: '#92400e',
            marginBottom: '1rem',
            fontSize: '0.875rem',
            fontWeight: 500,
          }}
        >
          บันทึกการแก้ไขครุภัณฑ์สำเร็จ แต่การดึงข้อมูลล่าสุดล้มเหลว กรุณากดปุ่มเพื่อโหลดข้อมูลใหม่
        </div>
      )}

      {/* Error alert */}
      {submitError && (
        <div
          role="alert"
          data-testid="correction-error-message"
          style={{
            padding: '0.75rem 1rem',
            backgroundColor: '#fee2e2',
            color: '#991b1b',
            borderRadius: '6px',
            marginBottom: '1rem',
            fontSize: '0.875rem',
            fontWeight: 500,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{submitError}</span>
          {isPendingUncertain && (
            <button
              type="button"
              id="retry-uncertain-btn"
              onClick={retryUncertain}
              disabled={isSubmitting}
              style={{
                marginLeft: '1rem',
                padding: '0.375rem 0.75rem',
                backgroundColor: '#991b1b',
                color: '#ffffff',
                border: 'none',
                borderRadius: '4px',
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
                fontWeight: 600,
                fontSize: '0.8125rem',
                whiteSpace: 'nowrap',
              }}
            >
              {isSubmitting ? 'กำลังส่งซ้ำ...' : 'ลองส่งซ้ำ (Retry with same token)'}
            </button>
          )}
        </div>
      )}

      {/* Name Field */}
      <div style={{ marginBottom: '1rem' }}>
        <label
          htmlFor="name"
          style={{
            display: 'block',
            fontWeight: 500,
            fontSize: '0.875rem',
            color: '#374151',
            marginBottom: '0.25rem',
          }}
        >
          ชื่อ / คำอธิบายครุภัณฑ์ {!isLegacy && <span style={{ color: '#ef4444' }}>*</span>}
        </label>
        <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '0.25rem' }}>
          ค่าปัจจุบัน: {baselineExpected.name || '(ไม่ระบุ)'}
        </div>
        <input
          id="name"
          type="text"
          disabled={isFormDisabled}
          {...register('name')}
          placeholder={isLegacy ? 'เว้นว่างได้สำหรับข้อมูลตกทอด' : 'ระบุชื่อครุภัณฑ์'}
          style={{
            width: '100%',
            padding: '0.5rem 0.75rem',
            border: errors.name ? '1px solid #ef4444' : '1px solid #d1d5db',
            borderRadius: '6px',
            fontSize: '0.875rem',
            boxSizing: 'border-box',
          }}
        />
        {errors.name && (
          <p style={{ color: '#ef4444', fontSize: '0.75rem', margin: '0.25rem 0 0 0' }}>
            {errors.name.message}
          </p>
        )}
      </div>

      {/* Asset Number Field */}
      <div style={{ marginBottom: '1rem' }}>
        <label
          htmlFor="asset_number"
          style={{
            display: 'block',
            fontWeight: 500,
            fontSize: '0.875rem',
            color: '#374151',
            marginBottom: '0.25rem',
          }}
        >
          เลขครุภัณฑ์
        </label>
        <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '0.25rem' }}>
          ค่าปัจจุบัน: {baselineExpected.asset_number || '(ไม่มีข้อมูล)'}
        </div>
        <input
          id="asset_number"
          type="text"
          disabled={isFormDisabled}
          {...register('asset_number')}
          onChange={(e) => handleIdentifierChange('asset_number', e.target.value)}
          placeholder="เว้นว่างได้หากไม่มี"
          style={{
            width: '100%',
            padding: '0.5rem 0.75rem',
            border: errors.asset_number ? '1px solid #ef4444' : '1px solid #d1d5db',
            borderRadius: '6px',
            fontSize: '0.875rem',
            boxSizing: 'border-box',
          }}
        />
        {errors.asset_number && (
          <p style={{ color: '#ef4444', fontSize: '0.75rem', margin: '0.25rem 0 0 0' }}>
            {errors.asset_number.message}
          </p>
        )}
      </div>

      {/* Serial Number Field */}
      <div style={{ marginBottom: '1rem' }}>
        <label
          htmlFor="serial_number"
          style={{
            display: 'block',
            fontWeight: 500,
            fontSize: '0.875rem',
            color: '#374151',
            marginBottom: '0.25rem',
          }}
        >
          หมายเลขซีเรียล (Serial Number)
        </label>
        <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '0.25rem' }}>
          ค่าปัจจุบัน: {baselineExpected.serial_number || '(ไม่มีข้อมูล)'}
        </div>
        <input
          id="serial_number"
          type="text"
          disabled={isFormDisabled}
          {...register('serial_number')}
          onChange={(e) => handleIdentifierChange('serial_number', e.target.value)}
          placeholder="เว้นว่างได้หากไม่มี"
          style={{
            width: '100%',
            padding: '0.5rem 0.75rem',
            border: errors.serial_number ? '1px solid #ef4444' : '1px solid #d1d5db',
            borderRadius: '6px',
            fontSize: '0.875rem',
            boxSizing: 'border-box',
          }}
        />
        {errors.serial_number && (
          <p style={{ color: '#ef4444', fontSize: '0.75rem', margin: '0.25rem 0 0 0' }}>
            {errors.serial_number.message}
          </p>
        )}
      </div>

      {/* Duplicate candidate check button */}
      {(watchedAssetNumber || watchedSerialNumber) && (
        <div style={{ marginBottom: '1rem' }}>
          <button
            type="button"
            id="check-duplicate-btn"
            onClick={() => handleCheckDuplicates(0, false)}
            disabled={isCheckingDuplicates || isFormDisabled}
            style={{
              padding: '0.375rem 0.75rem',
              backgroundColor: '#f3f4f6',
              border: '1px solid #d1d5db',
              borderRadius: '4px',
              fontSize: '0.8125rem',
              color: '#374151',
              cursor: isCheckingDuplicates || isFormDisabled ? 'not-allowed' : 'pointer',
            }}
          >
            {isCheckingDuplicates ? 'กำลังตรวจสอบ...' : '🔍 ตรวจสอบข้อมูลซ้ำ'}
          </button>
          {duplicateCheckError && (
            <p style={{ color: '#ef4444', fontSize: '0.75rem', margin: '0.25rem 0 0 0' }}>
              {duplicateCheckError}
            </p>
          )}
        </div>
      )}

      {/* Duplicate warning region */}
      {candidates.length > 0 && (
        <div
          role="region"
          aria-label="การแจ้งเตือนข้อมูลซ้ำ"
          style={{
            padding: '1rem',
            backgroundColor: '#fffbeb',
            border: '1px solid #f59e0b',
            borderRadius: '6px',
            marginBottom: '1rem',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              marginBottom: '0.5rem',
              fontWeight: 600,
              color: '#92400e',
              fontSize: '0.875rem',
            }}
          >
            <span>⚠️</span>
            <span>
              คำเตือน: พบครุภัณฑ์ที่มีเลขระบุตัวตนตรงกันในระบบ (แสดง {candidates.length} จากทั้งหมด {totalCandidateCount} รายการ)
            </span>
          </div>
          <div style={{ maxHeight: '120px', overflowY: 'auto', marginBottom: '0.75rem' }}>
            <table style={{ width: '100%', fontSize: '0.75rem', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid #fcd34d' }}>
                  <th style={{ padding: '0.25rem 0.5rem' }}>Stable ID</th>
                  <th style={{ padding: '0.25rem 0.5rem' }}>ชื่อครุภัณฑ์</th>
                  <th style={{ padding: '0.25rem 0.5rem' }}>เลขครุภัณฑ์</th>
                  <th style={{ padding: '0.25rem 0.5rem' }}>Serial Number</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => (
                  <tr key={c.id} style={{ borderBottom: '1px solid #fef3c7' }}>
                    <td style={{ padding: '0.25rem 0.5rem', fontFamily: 'monospace' }}>
                      {c.id.substring(0, 8)}...
                    </td>
                    <td style={{ padding: '0.25rem 0.5rem' }}>{c.name || '-'}</td>
                    <td style={{ padding: '0.25rem 0.5rem' }}>{c.asset_number || '-'}</td>
                    <td style={{ padding: '0.25rem 0.5rem' }}>{c.serial_number || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasMoreCandidates && (
            <div style={{ marginBottom: '0.75rem' }}>
              <button
                type="button"
                id="load-more-candidates-btn"
                onClick={() => handleCheckDuplicates(candidates.length, true)}
                disabled={isLoadingMoreCandidates || isFormDisabled}
                style={{
                  padding: '0.25rem 0.5rem',
                  backgroundColor: '#fef3c7',
                  border: '1px solid #d97706',
                  borderRadius: '4px',
                  fontSize: '0.75rem',
                  color: '#92400e',
                  cursor: isLoadingMoreCandidates || isFormDisabled ? 'not-allowed' : 'pointer',
                  fontWeight: 500,
                }}
              >
                {isLoadingMoreCandidates ? 'กำลังโหลด...' : 'โหลดข้อมูลเพิ่มเติม (Load More)'}
              </button>
            </div>
          )}

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontSize: '0.8125rem',
              color: '#78350f',
              cursor: isFormDisabled ? 'not-allowed' : 'pointer',
            }}
          >
            <input
              type="checkbox"
              id="explicit_continuation"
              disabled={isFormDisabled}
              {...register('explicit_continuation')}
            />
            <span>ข้าพเจ้ายืนยันที่จะบันทึกการแก้ไขนี้แม้มีข้อมูลใกล้เคียงกัน</span>
          </label>
        </div>
      )}

      {/* Reason Field (Mandatory per P2) */}
      <div style={{ marginBottom: '1.25rem' }}>
        <label
          htmlFor="reason"
          style={{
            display: 'block',
            fontWeight: 500,
            fontSize: '0.875rem',
            color: '#374151',
            marginBottom: '0.25rem',
          }}
        >
          เหตุผลในการแก้ไขข้อมูล <span style={{ color: '#ef4444' }}>*</span>
        </label>
        <textarea
          id="reason"
          rows={3}
          disabled={isFormDisabled}
          {...register('reason')}
          placeholder="ระบุเหตุผลในการแก้ไข เช่น แก้ไขเพื่อความถูกต้องตามผลการตรวจนับพัสดุประจำปี"
          style={{
            width: '100%',
            padding: '0.5rem 0.75rem',
            border: errors.reason ? '1px solid #ef4444' : '1px solid #d1d5db',
            borderRadius: '6px',
            fontSize: '0.875rem',
            boxSizing: 'border-box',
          }}
        />
        {errors.reason && (
          <p style={{ color: '#ef4444', fontSize: '0.75rem', margin: '0.25rem 0 0 0' }}>
            {errors.reason.message}
          </p>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <button
          type="submit"
          id="submit-correct-btn"
          disabled={isSubmitting || isCommittedAwaitingRefresh}
          style={{
            padding: '0.5rem 1.25rem',
            backgroundColor: '#2563eb',
            color: '#ffffff',
            border: 'none',
            borderRadius: '6px',
            fontSize: '0.875rem',
            fontWeight: 500,
            cursor: isSubmitting || isCommittedAwaitingRefresh ? 'not-allowed' : 'pointer',
          }}
        >
          {isSubmitting
            ? 'กำลังบันทึก...'
            : isCommittedAwaitingRefresh
            ? '⏳ รอการรีเฟรชข้อมูล...'
            : isPendingUncertain
            ? '💾 ลองส่งซ้ำ (Retry)'
            : '💾 บันทึกการแก้ไข'}
        </button>
        {onCancel && (
          <button
            type="button"
            id="cancel-correct-btn"
            onClick={onCancel}
            disabled={isSubmitting || isPendingUncertain || isCommittedAwaitingRefresh}
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: '#f3f4f6',
              color: '#374151',
              border: '1px solid #d1d5db',
              borderRadius: '6px',
              fontSize: '0.875rem',
              cursor: isSubmitting || isPendingUncertain || isCommittedAwaitingRefresh ? 'not-allowed' : 'pointer',
            }}
          >
            ยกเลิก
          </button>
        )}
      </div>
    </form>
  );
};
