import React, { useState, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type { AssetRecord } from '../pages/AssetDetail';

export interface AssetCorrectionFormProps {
  asset: AssetRecord;
  isLegacy?: boolean;
  csrfToken?: string | null;
  onSuccess: (updatedAsset: AssetRecord) => void;
  onCancel?: () => void;
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
}) => {
  const retryTokenRef = useRef<string>(crypto.randomUUID());

  const [candidates, setCandidates] = useState<DuplicateCandidate[]>([]);
  const [isCheckingDuplicates, setIsCheckingDuplicates] = useState(false);
  const [duplicateCheckError, setDuplicateCheckError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    setError,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    defaultValues: {
      name: asset.name || '',
      asset_number: asset.asset_number || '',
      serial_number: asset.serial_number || '',
      reason: '',
      explicit_continuation: false,
    },
  });

  const watchedAssetNumber = watch('asset_number');
  const watchedSerialNumber = watch('serial_number');

  // When identifier fields change, reset duplicate candidate warning and explicit continuation
  const handleIdentifierChange = (field: 'asset_number' | 'serial_number', val: string) => {
    setValue(field, val);
    setCandidates([]);
    setDuplicateCheckError(null);
    setValue('explicit_continuation', false);
  };

  // Duplicate candidates preview
  const handleCheckDuplicates = async () => {
    const curAssetNumber = (watchedAssetNumber || '').trim();
    const curSerialNumber = (watchedSerialNumber || '').trim();

    if (!curAssetNumber && !curSerialNumber) {
      setCandidates([]);
      return;
    }

    setIsCheckingDuplicates(true);
    setDuplicateCheckError(null);

    try {
      const params = new URLSearchParams();
      if (curAssetNumber) params.append('asset_number', curAssetNumber);
      if (curSerialNumber) params.append('serial_number', curSerialNumber);

      const res = await fetch(`/assets/${asset.id}/duplicate-candidates?${params.toString()}`, {
        method: 'GET',
        credentials: 'include',
      });

      if (res.status === 403) {
        setDuplicateCheckError('คุณไม่มีสิทธิ์ตรวจสอบข้อมูลซ้ำ (403 Forbidden)');
        setIsCheckingDuplicates(false);
        return;
      }

      if (!res.ok) {
        setDuplicateCheckError('ไม่สามารถตรวจสอบข้อมูลซ้ำได้');
        setIsCheckingDuplicates(false);
        return;
      }

      const data = await res.json();
      setCandidates(data.candidates || []);
      if (!data.candidates || data.candidates.length === 0) {
        setValue('explicit_continuation', false);
      }
    } catch {
      setDuplicateCheckError('เกิดข้อผิดพลาดในการเชื่อมต่อเพื่อตรวจสอบข้อมูลซ้ำ');
    } finally {
      setIsCheckingDuplicates(false);
    }
  };

  const onSubmit = async (data: FormValues) => {
    setSubmitError(null);
    setSuccessMessage(null);

    // 1. Zod client-side validation
    const schema = z.object({
      name: isLegacy ? z.string() : z.string().trim().min(1, 'กรุณาระบุชื่อหรือคำอธิบายครุภัณฑ์'),
      asset_number: z.string(),
      serial_number: z.string(),
      reason: z.string().trim().min(1, 'กรุณาระบุเหตุผลในการแก้ไขข้อมูลครุภัณฑ์'),
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

    // AR-08 rule: cannot clear non-null asset_number
    const trimmedAssetNum = data.asset_number.trim();
    if (asset.asset_number && asset.asset_number.trim().length > 0 && trimmedAssetNum.length === 0) {
      setError('asset_number', {
        type: 'manual',
        message: 'ไม่สามารถลบเลขครุภัณฑ์ที่มีอยู่แล้วออกได้ตามกฎ AR-08',
      });
      return;
    }

    // Check duplicate warning acknowledgement requirement
    if (candidates.length > 0 && !data.explicit_continuation) {
      setSubmitError('พบข้อมูลซ้ำในระบบ โปรดตรวจสอบและยืนยันการบันทึกการแก้ไขก่อนดำเนินการต่อ');
      return;
    }

    setIsSubmitting(true);

    const trimmedName = data.name.trim();
    const trimmedSerialNum = data.serial_number.trim();
    const trimmedReason = data.reason.trim();

    const payload = {
      name: isLegacy && trimmedName.length === 0 ? null : trimmedName,
      asset_number: trimmedAssetNum.length === 0 ? null : trimmedAssetNum,
      serial_number: trimmedSerialNum.length === 0 ? null : trimmedSerialNum,
      expected_name: asset.name,
      expected_asset_number: asset.asset_number,
      expected_serial_number: asset.serial_number,
      reason: trimmedReason,
      explicit_continuation: data.explicit_continuation,
      retry_token: retryTokenRef.current,
    };

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-retry-token': retryTokenRef.current,
      };
      if (csrfToken) {
        headers['x-csrf-token'] = csrfToken;
      }

      const res = await fetch(`/assets/${asset.id}/correct`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      if (res.status === 409) {
        const errJson = await res.json().catch(() => null);
        if (errJson?.code === 'STALE_BEFORE_CONFLICT') {
          setSubmitError(
            'ข้อมูลครุภัณฑ์ถูกแก้ไขโดยผู้อื่นแล้ว กรุณารีเฟรชข้อมูลล่าสุดก่อนดำเนินการต่อ (409 Conflict)'
          );
        } else if (errJson?.code === 'DUPLICATE_WARNING') {
          setCandidates(errJson.candidates || []);
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
        const errJson = await res.json().catch(() => null);
        setSubmitError(errJson?.message || 'ข้อมูลที่ส่งไม่ถูกต้อง (400 Bad Request)');
        setIsSubmitting(false);
        return;
      }

      if (res.status === 403) {
        setSubmitError('คุณไม่มีสิทธิ์แก้ไขข้อมูลครุภัณฑ์นี้ (403 Forbidden)');
        setIsSubmitting(false);
        return;
      }

      if (!res.ok) {
        // Transport or server error: KEEP retry token unchanged for safe retry
        setSubmitError('เกิดข้อผิดพลาดในการบันทึกข้อมูล กรุณากดบันทึกซ้ำเพื่อดำเนินการต่อได้อย่างปลอดภัย');
        setIsSubmitting(false);
        return;
      }

      const result = await res.json();
      setSuccessMessage('บันทึกการแก้ไขครุภัณฑ์สำเร็จ');
      // Fresh token for future edits
      retryTokenRef.current = crypto.randomUUID();
      setIsSubmitting(false);

      if (result?.asset) {
        onSuccess(result.asset);
      }
    } catch {
      // Network error: PRESERVE retry token for safe user retry
      setSubmitError(
        'เกิดข้อผิดพลาดในการเชื่อมต่อเครือข่าย ท่านสามารถกดบันทึกซ้ำเพื่อดำเนินการต่อได้อย่างปลอดภัย'
      );
      setIsSubmitting(false);
    }
  };

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
          }}
        >
          {submitError}
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
          ค่าปัจจุบัน: {asset.name || '(ไม่ระบุ)'}
        </div>
        <input
          id="name"
          type="text"
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
          ค่าปัจจุบัน: {asset.asset_number || '(ไม่มีข้อมูล)'}
        </div>
        <input
          id="asset_number"
          type="text"
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
          ค่าปัจจุบัน: {asset.serial_number || '(ไม่มีข้อมูล)'}
        </div>
        <input
          id="serial_number"
          type="text"
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
            <span>คำเตือน: พบครุภัณฑ์ที่มีเลขระบุตัวตนตรงกันในระบบ ({candidates.length} รายการ)</span>
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

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontSize: '0.8125rem',
              color: '#78350f',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              id="explicit_continuation"
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
          disabled={isSubmitting}
          style={{
            padding: '0.5rem 1.25rem',
            backgroundColor: '#2563eb',
            color: '#ffffff',
            border: 'none',
            borderRadius: '6px',
            fontSize: '0.875rem',
            fontWeight: 500,
            cursor: isSubmitting ? 'not-allowed' : 'pointer',
          }}
        >
          {isSubmitting ? 'กำลังบันทึก...' : '💾 บันทึกการแก้ไข'}
        </button>
        {onCancel && (
          <button
            type="button"
            id="cancel-correct-btn"
            onClick={onCancel}
            disabled={isSubmitting}
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: '#f3f4f6',
              color: '#374151',
              border: '1px solid #d1d5db',
              borderRadius: '6px',
              fontSize: '0.875rem',
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
            }}
          >
            ยกเลิก
          </button>
        )}
      </div>
    </form>
  );
};
