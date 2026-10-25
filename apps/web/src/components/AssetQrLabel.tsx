import React, { useState, useEffect, useCallback, useRef } from 'react';
import { flushSync } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';
// @ts-ignore
import './AssetQrLabel.css';

export interface QrLabelData {
  id: string;
  locator: string;
  name: string | null;
  asset_number: string | null;
  serial_number: string | null;
}

export interface AssetQrLabelProps {
  assetId: string;
  asset?: {
    id: string;
    name: string | null;
    asset_number: string | null;
    serial_number: string | null;
  } | null;
  currentUser?: {
    id: string;
    role?: string;
  } | null;
  dataUpdatedAt?: number;
  refreshError?: string | null;
  onPermissionRevoked?: (statusCode?: number) => void;
}

export const AssetQrLabel: React.FC<AssetQrLabelProps> = ({
  assetId,
  currentUser,
  dataUpdatedAt,
  refreshError,
  onPermissionRevoked,
}) => {
  const [qrData, setQrData] = useState<QrLabelData | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isPrinting, setIsPrinting] = useState<boolean>(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const genRef = useRef<number>(0);

  // Invalidate label state and abort in-flight requests on asset or session change
  useEffect(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    genRef.current += 1;
    setQrData(null);
    setError(null);
    setLoading(false);
  }, [assetId, currentUser?.id, currentUser?.role]);

  // Invalidate generated QR facts and abort/retire pending ownership when parent asset data updates (e.g. metadata correction)
  const prevDataUpdatedAtRef = useRef(dataUpdatedAt);
  useEffect(() => {
    if (prevDataUpdatedAtRef.current !== dataUpdatedAt) {
      prevDataUpdatedAtRef.current = dataUpdatedAt;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      genRef.current += 1;
      setQrData(null);
      setLoading(false);
    }
  }, [dataUpdatedAt]);

  // Suppress/invalidate on parent refresh error
  useEffect(() => {
    if (refreshError) {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      genRef.current += 1;
      setQrData(null);
      setLoading(false);
    }
  }, [refreshError]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const fetchQrData = useCallback(async (): Promise<QrLabelData | null> => {
    if (refreshError) {
      return null;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const currentGen = ++genRef.current;

    try {
      const res = await fetch(`/assets/${assetId}/qr-label`, {
        headers: {
          accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (currentGen !== genRef.current || controller.signal.aborted) {
        return null;
      }

      if (!res.ok) {
        setQrData(null);
        if (res.status === 401 || res.status === 403) {
          if (onPermissionRevoked) {
            onPermissionRevoked(res.status);
          }
          setError(
            `คุณไม่มีสิทธิ์เข้าถึงหรือพิมพ์ QR Code สำหรับครุภัณฑ์นี้ (${
              res.status === 401 ? '401 Unauthorized' : '403 Forbidden'
            })`
          );
          return null;
        }

        if (res.status === 503) {
          setError('ระบบยังไม่ได้กำหนดที่อยู่สาธารณะสำหรับสร้าง QR Code (503 Service Unavailable)');
          return null;
        }

        if (res.status === 404) {
          setError('ไม่พบข้อมูลครุภัณฑ์สำหรับสร้าง QR Code (404 Not Found)');
          return null;
        }

        setError('เกิดข้อผิดพลาดในการโหลดข้อมูล QR Code');
        return null;
      }

      const data: QrLabelData = await res.json();
      if (currentGen !== genRef.current || controller.signal.aborted) {
        return null;
      }

      setError(null);
      return data;
    } catch (err: unknown) {
      if (
        currentGen !== genRef.current ||
        (err instanceof DOMException && err.name === 'AbortError')
      ) {
        return null;
      }
      setQrData(null);
      setError('เกิดข้อผิดพลาดในการเชื่อมต่อเพื่อดึงข้อมูล QR Code');
      return null;
    }
  }, [assetId, refreshError, onPermissionRevoked]);

  const handleGenerate = async () => {
    setError(null);
    setLoading(true);
    try {
      const data = await fetchQrData();
      if (data) {
        setQrData(data);
      }
    } finally {
      setLoading(false);
    }
  };

  const handlePrint = async () => {
    setIsPrinting(true);
    setError(null);
    try {
      // Authoritative pre-print fetch
      const freshData = await fetchQrData();
      if (freshData) {
        // Force React 19 to synchronously commit the fresh label data to the DOM before print dialog opens
        flushSync(() => {
          setQrData(freshData);
        });

        // Activate print scope on body
        document.body.classList.add('t8-print-active');
        try {
          window.print();
        } finally {
          document.body.classList.remove('t8-print-active');
        }
      } else {
        // Suppress protected label facts immediately on failed authoritative pre-print read
        flushSync(() => {
          setQrData(null);
        });
      }
    } finally {
      setIsPrinting(false);
    }
  };

  const fallbackNotSpecified = 'ไม่ระบุในทะเบียน';

  return (
    <section
      aria-labelledby="qr-label-heading"
      className="asset-qr-panel"
      data-testid="asset-qr-panel"
    >
      <h3 id="qr-label-heading" className="asset-qr-panel-title">
        รหัส QR สำหรับครุภัณฑ์ (QR Code Label)
      </h3>

      {loading && !qrData && (
        <div data-testid="asset-qr-loading" style={{ color: '#6b7280', fontSize: '0.875rem' }}>
          กำลังโหลดข้อมูล QR Code...
        </div>
      )}

      {error && (
        <div
          role="alert"
          data-testid="asset-qr-error"
          className="asset-qr-error no-print"
        >
          {error}
        </div>
      )}

      {qrData && (
        <div
          className="asset-qr-label-card asset-qr-label-printable"
          data-testid="asset-qr-label-card"
        >
          <div
            className="asset-qr-code-wrapper"
            data-testid="asset-qr-code-wrapper"
          >
            <QRCodeSVG
              value={qrData.locator}
              size={128}
              level="M"
              includeMargin={true}
              data-testid="asset-qr-svg"
            />
          </div>
          <div className="asset-qr-details">
            <div className="asset-qr-field" data-testid="asset-qr-name">
              <strong>ชื่อครุภัณฑ์:</strong>
              <span>{qrData.name && qrData.name.trim() ? qrData.name : fallbackNotSpecified}</span>
            </div>
            <div className="asset-qr-field" data-testid="asset-qr-number">
              <strong>หมายเลขครุภัณฑ์:</strong>
              <span className="mono">{qrData.asset_number && qrData.asset_number.trim() ? qrData.asset_number : fallbackNotSpecified}</span>
            </div>
            <div className="asset-qr-field" data-testid="asset-qr-serial">
              <strong>Serial Number:</strong>
              <span className="mono">{qrData.serial_number && qrData.serial_number.trim() ? qrData.serial_number : fallbackNotSpecified}</span>
            </div>
            <div className="asset-qr-field" data-testid="asset-qr-uuid">
              <strong>Stable UUID:</strong>
              <span className="mono">{qrData.id}</span>
            </div>
            {/* Locator URL is kept out of printed label via no-print class */}
            <div className="asset-qr-field no-print" data-testid="asset-qr-locator">
              <strong>Locator:</strong>
              <span className="mono">{qrData.locator}</span>
            </div>
          </div>
        </div>
      )}

      <div className="asset-qr-actions no-print" style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
        <button
          type="button"
          id="generate-qr-btn"
          data-testid="generate-qr-btn"
          className="btn-generate-qr no-print"
          onClick={handleGenerate}
          disabled={loading || Boolean(refreshError)}
        >
          {loading ? 'กำลังสร้าง QR Code...' : qrData ? 'สร้าง QR Code ใหม่ (Regenerate)' : 'สร้าง QR Code (Generate)'}
        </button>

        {qrData && (
          <button
            type="button"
            id="print-qr-label-btn"
            data-testid="print-qr-label-btn"
            className="btn-print-qr no-print"
            onClick={handlePrint}
            disabled={isPrinting || loading || Boolean(refreshError)}
          >
            {isPrinting ? 'กำลังเตรียมพิมพ์...' : 'พิมพ์ฉลาก (Print Label)'}
          </button>
        )}
      </div>
    </section>
  );
};

export default AssetQrLabel;
