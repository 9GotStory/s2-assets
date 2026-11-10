import React, { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router';

export interface SafeUser {
  id: string;
  username: string;
  is_active: boolean;
  created_at?: string | Date;
  updated_at?: string | Date;
}

export interface SessionCheckResponse {
  user: SafeUser;
  csrfToken: string;
}

export const Dashboard: React.FC = () => {
  const [user, setUser] = useState<SafeUser | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

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
          // Unauthenticated, expired, or invalid session -> redirect to login
          navigate('/login', { replace: true });
          return;
        }

        const data: SessionCheckResponse = await response.json();
        if (data && data.user) {
          setUser(data.user);
          // Keep CSRF token in in-memory React state only (never in storage or cookie reads)
          setCsrfToken(data.csrfToken || null);
          setIsLoading(false);
        } else {
          navigate('/login', { replace: true });
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          // Component unmounted, ignore abort
          return;
        }
        // Network or unexpected failure -> redirect to login
        navigate('/login', { replace: true });
      }
    };

    verifySession();

    return () => {
      controller.abort();
    };
  }, [navigate]);

  const handleLogout = async () => {
    if (isLoggingOut) {
      return;
    }

    setIsLoggingOut(true);
    setLogoutError(null);

    try {
      const headers: Record<string, string> = {};
      if (csrfToken) {
        headers['x-csrf-token'] = csrfToken;
      }

      const response = await fetch('/auth/logout', {
        method: 'POST',
        headers,
        credentials: 'include',
      });

      if (response.ok) {
        // Confirmed logout success: clear in-memory state and redirect to login
        setUser(null);
        setCsrfToken(null);
        navigate('/login', { replace: true });
        return;
      }

      // Safe error handling: do NOT present session as revoked if logout failed
      setLogoutError('ไม่สามารถออกจากระบบได้ กรุณาลองใหม่อีกครั้ง');
    } catch {
      // Network failure: do NOT present session as revoked
      setLogoutError('เกิดข้อผิดพลาดในการเชื่อมต่อ ไม่สามารถออกจากระบบได้ กรุณาลองใหม่อีกครั้ง');
    } finally {
      setIsLoggingOut(false);
    }
  };

  if (isLoading) {
    return (
      <main
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
          padding: '1rem',
          boxSizing: 'border-box',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          backgroundColor: '#f5f5f5',
        }}
      >
        <div
          role="status"
          aria-live="polite"
          style={{
            fontSize: '1rem',
            color: '#4b5563',
            textAlign: 'center',
          }}
        >
          กำลังตรวจสอบสิทธิ์การเข้าใช้งาน...
        </div>
      </main>
    );
  }

  if (!user) {
    return null;
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
          maxWidth: '800px',
          margin: '0 auto',
          backgroundColor: '#ffffff',
          borderRadius: '8px',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
          padding: '2rem',
          boxSizing: 'border-box',
        }}
      >
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: '1px solid #e5e7eb',
            paddingBottom: '1rem',
            marginBottom: '1.5rem',
            flexWrap: 'wrap',
            gap: '1rem',
          }}
        >
          <h1
            style={{
              fontSize: '1.5rem',
              fontWeight: 600,
              margin: 0,
              color: '#111827',
            }}
          >
            แดชบอร์ด
          </h1>
          <button
            type="button"
            onClick={handleLogout}
            disabled={isLoggingOut}
            aria-busy={isLoggingOut}
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: isLoggingOut ? '#9ca3af' : '#dc2626',
              color: '#ffffff',
              border: 'none',
              borderRadius: '4px',
              fontSize: '0.875rem',
              fontWeight: 500,
              cursor: isLoggingOut ? 'not-allowed' : 'pointer',
              transition: 'background-color 0.2s',
            }}
          >
            {isLoggingOut ? 'กำลังออกจากระบบ...' : 'ออกจากระบบ'}
          </button>
        </header>

        {logoutError && (
          <div
            role="alert"
            aria-live="polite"
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
            {logoutError}
          </div>
        )}

        <section
          aria-labelledby="user-info-heading"
          style={{
            backgroundColor: '#f9fafb',
            borderRadius: '6px',
            padding: '1.25rem',
            marginBottom: '1.5rem',
          }}
        >
          <h2
            id="user-info-heading"
            style={{
              fontSize: '1.125rem',
              fontWeight: 600,
              marginTop: 0,
              marginBottom: '1rem',
              color: '#374151',
            }}
          >
            ข้อมูลผู้ใช้งาน
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
            <dt style={{ fontWeight: 500, color: '#4b5563' }}>ชื่อผู้ใช้งาน:</dt>
            <dd style={{ margin: 0, color: '#111827', wordBreak: 'break-all' }}>
              {user.username}
            </dd>

            <dt style={{ fontWeight: 500, color: '#4b5563' }}>รหัสผู้ใช้:</dt>
            <dd style={{ margin: 0, color: '#111827', wordBreak: 'break-all' }}>
              {user.id}
            </dd>

            <dt style={{ fontWeight: 500, color: '#4b5563' }}>สถานะบัญชี:</dt>
            <dd style={{ margin: 0, color: '#111827' }}>
              {user.is_active ? 'เปิดใช้งาน' : 'ระงับการใช้งาน'}
            </dd>

            {user.created_at && (
              <>
                <dt style={{ fontWeight: 500, color: '#4b5563' }}>วันที่สร้างบัญชี:</dt>
                <dd style={{ margin: 0, color: '#111827' }}>
                  {typeof user.created_at === 'string'
                    ? user.created_at
                    : user.created_at.toISOString()}
                </dd>
              </>
            )}
          </dl>
        </section>

        <section
          aria-labelledby="registry-heading"
          style={{
            backgroundColor: '#f9fafb',
            borderRadius: '6px',
            padding: '1.25rem',
            marginBottom: '1.5rem',
          }}
        >
          <h2
            id="registry-heading"
            style={{
              fontSize: '1.125rem',
              fontWeight: 600,
              marginTop: 0,
              marginBottom: '0.5rem',
              color: '#374151',
            }}
          >
            งานทะเบียนครุภัณฑ์ (Asset Registry)
          </h2>
          <p style={{ margin: '0 0 1rem 0', fontSize: '0.875rem', color: '#4b5563' }}>
            ระบบบันทึกและจัดการข้อมูลครุภัณฑ์รายชิ้น
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <Link
              to="/assets/register"
              id="nav-asset-register"
              style={{
                display: 'inline-block',
                padding: '0.5rem 1rem',
                backgroundColor: '#2563eb',
                color: '#ffffff',
                textDecoration: 'none',
                borderRadius: '4px',
                fontSize: '0.875rem',
                fontWeight: 500,
              }}
            >
              + ลงทะเบียนครุภัณฑ์ใหม่
            </Link>
            <Link
              to="/assets/bulk-register"
              id="nav-asset-bulk-register"
              style={{
                display: 'inline-block',
                padding: '0.5rem 1rem',
                backgroundColor: '#1d4ed8',
                color: '#ffffff',
                textDecoration: 'none',
                borderRadius: '4px',
                fontSize: '0.875rem',
                fontWeight: 500,
              }}
            >
              + ลงทะเบียนแบบกลุ่ม (Bulk)
            </Link>
            <Link
              to="/assets/search"
              id="nav-asset-search"
              style={{
                display: 'inline-block',
                padding: '0.5rem 1rem',
                backgroundColor: '#4b5563',
                color: '#ffffff',
                textDecoration: 'none',
                borderRadius: '4px',
                fontSize: '0.875rem',
                fontWeight: 500,
              }}
            >
              🔍 ค้นหาครุภัณฑ์
            </Link>
            <Link
              to="/admin/references"
              id="nav-reference-lists"
              style={{
                display: 'inline-block',
                padding: '0.5rem 1rem',
                backgroundColor: '#ffffff',
                color: '#374151',
                border: '1px solid #d1d5db',
                textDecoration: 'none',
                borderRadius: '4px',
                fontSize: '0.875rem',
                fontWeight: 500,
              }}
            >
              🗂️ รายการข้อมูลอ้างอิง
            </Link>
          </div>
        </section>

        <section
          aria-labelledby="acquisition-heading"
          style={{
            backgroundColor: '#f9fafb',
            borderRadius: '6px',
            padding: '1.25rem',
            marginBottom: '1.5rem',
          }}
        >
          <h2
            id="acquisition-heading"
            style={{
              fontSize: '1.125rem',
              fontWeight: 600,
              marginTop: 0,
              marginBottom: '0.5rem',
              color: '#374151',
            }}
          >
            การได้มาของครุภัณฑ์ (Acquisitions)
          </h2>
          <p style={{ margin: '0 0 1rem 0', fontSize: '0.875rem', color: '#4b5563' }}>
            บันทึกและจัดการรายการอ้างอิงการได้มาแบบกลุ่ม/จัดซื้อรวม (Lightweight Acquisition)
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <Link
              to="/acquisitions/new"
              id="nav-acquisition-create"
              style={{
                display: 'inline-block',
                padding: '0.5rem 1rem',
                backgroundColor: '#059669',
                color: '#ffffff',
                textDecoration: 'none',
                borderRadius: '4px',
                fontSize: '0.875rem',
                fontWeight: 500,
              }}
            >
              + บันทึกข้อมูลการได้มาใหม่
            </Link>
          </div>
        </section>

        <section
          aria-labelledby="loan-heading"
          style={{
            backgroundColor: '#f9fafb',
            borderRadius: '6px',
            padding: '1.25rem',
            marginBottom: '1.5rem',
          }}
        >
          <h2
            id="loan-heading"
            style={{
              fontSize: '1.125rem',
              fontWeight: 600,
              marginTop: 0,
              marginBottom: '0.5rem',
              color: '#374151',
            }}
          >
            การยืม
          </h2>
          <p style={{ margin: '0 0 1rem 0', fontSize: '0.875rem', color: '#4b5563' }}>
            ดูว่าใครยืมครุภัณฑ์ใดอยู่ คืนแล้วเท่าใด และรายการใดเกินกำหนด
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <Link
              to="/loans"
              id="nav-loan-list"
              style={{
                display: 'inline-block',
                padding: '0.5rem 1rem',
                backgroundColor: '#4b5563',
                color: '#ffffff',
                textDecoration: 'none',
                borderRadius: '4px',
                fontSize: '0.875rem',
                fontWeight: 500,
              }}
            >
              รายการยืม
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
};

export default Dashboard;
