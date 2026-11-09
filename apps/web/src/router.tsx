import React, { useEffect, useState, useRef } from 'react';
import type { RouteObject } from 'react-router';
import { createBrowserRouter, Navigate, useNavigate, useParams, Link } from 'react-router';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { AssetRegister } from './pages/AssetRegister';
import { AssetSearch } from './pages/AssetSearch';
import { AssetDetail } from './pages/AssetDetail';
import { AcquisitionCreate } from './pages/AcquisitionCreate';
import { AcquisitionDetail } from './pages/AcquisitionDetail';
import { AssetBulkRegister } from './pages/AssetBulkRegister';
import { ReferenceAdmin } from './pages/ReferenceAdmin';
import { LoanDetail } from './pages/LoanDetail';

export const ProtectedDetailBoundary: React.FC = () => {
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  const [sessionVerified, setSessionVerified] = useState(false);
  const [boundaryError, setBoundaryError] = useState<string | null>(null);
  const [actorEpoch, setActorEpoch] = useState(0);

  const boundaryGenRef = useRef<number>(0);
  const currentActorIdRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef<boolean>(true);

  const revalidate = async () => {
    const targetId = params.id;
    if (!targetId || !isMountedRef.current) {
      if (!targetId && isMountedRef.current) {
        setBoundaryError('ไม่พบรหัสครุภัณฑ์ที่ต้องการเรียกดู');
        setSessionVerified(false);
      }
      return;
    }

    // 1. Advance generation counter and abort in-flight work
    const currentGen = ++boundaryGenRef.current;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // 2. Hide protected data before revalidation
    setSessionVerified(false);
    setBoundaryError(null);

    try {
      // Step A: Current session validation
      const sessionRes = await fetch('/auth/session-check', {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal,
      });

      // Guard: Discard obsolete response immediately
      if (
        !isMountedRef.current ||
        currentGen !== boundaryGenRef.current ||
        params.id !== targetId ||
        controller.signal.aborted
      ) {
        return;
      }

      if (!sessionRes.ok) {
        if (isMountedRef.current && currentGen === boundaryGenRef.current && !controller.signal.aborted) {
          currentActorIdRef.current = null;
          navigate('/login', { replace: true });
        }
        return;
      }

      let sessionData: any = null;
      try {
        sessionData = await sessionRes.json();
      } catch (parseErr: unknown) {
        if (
          !isMountedRef.current ||
          currentGen !== boundaryGenRef.current ||
          params.id !== targetId ||
          controller.signal.aborted ||
          (parseErr instanceof DOMException && parseErr.name === 'AbortError')
        ) {
          return;
        }
        sessionData = null;
      }

      if (
        !isMountedRef.current ||
        currentGen !== boundaryGenRef.current ||
        params.id !== targetId ||
        controller.signal.aborted
      ) {
        return;
      }

      const actorId = sessionData?.user?.id;
      if (!actorId) {
        if (isMountedRef.current && currentGen === boundaryGenRef.current && !controller.signal.aborted) {
          currentActorIdRef.current = null;
          navigate('/login', { replace: true });
        }
        return;
      }

      if (currentActorIdRef.current !== null && currentActorIdRef.current !== actorId) {
        // Actor transitioned
        if (isMountedRef.current) {
          setActorEpoch((prev) => prev + 1);
        }
      }
      currentActorIdRef.current = actorId;

      // Step B: asset:view preflight GET /assets/:id
      const preflightRes = await fetch(`/assets/${targetId}`, {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal,
      });

      // Guard: Discard obsolete response immediately
      if (
        !isMountedRef.current ||
        currentGen !== boundaryGenRef.current ||
        params.id !== targetId ||
        controller.signal.aborted
      ) {
        return;
      }

      if (preflightRes.status === 401) {
        if (isMountedRef.current && currentGen === boundaryGenRef.current && !controller.signal.aborted) {
          currentActorIdRef.current = null;
          navigate('/login', { replace: true });
        }
        return;
      }

      if (preflightRes.status === 403) {
        if (isMountedRef.current && currentGen === boundaryGenRef.current && !controller.signal.aborted) {
          setBoundaryError('คุณไม่มีสิทธิ์เข้าถึงข้อมูลครุภัณฑ์นี้ (403 Forbidden)');
          setSessionVerified(false);
        }
        return;
      }

      if (preflightRes.status === 404) {
        if (isMountedRef.current && currentGen === boundaryGenRef.current && !controller.signal.aborted) {
          setBoundaryError('ไม่พบข้อมูลครุภัณฑ์ที่ระบุ (404 Not Found)');
          setSessionVerified(false);
        }
        return;
      }

      if (!preflightRes.ok) {
        if (isMountedRef.current && currentGen === boundaryGenRef.current && !controller.signal.aborted) {
          setBoundaryError('การตรวจสอบสิทธิ์การเข้าถึงข้อมูลครุภัณฑ์ล้มเหลว');
          setSessionVerified(false);
        }
        return;
      }

      // Preflight succeeded; discard preflight payload and authorize mount
      if (isMountedRef.current && currentGen === boundaryGenRef.current && !controller.signal.aborted) {
        setSessionVerified(true);
      }
    } catch (err: unknown) {
      if (
        !isMountedRef.current ||
        controller.signal.aborted ||
        currentGen !== boundaryGenRef.current ||
        (err instanceof DOMException && err.name === 'AbortError')
      ) {
        return;
      }
      if (isMountedRef.current && currentGen === boundaryGenRef.current && params.id === targetId) {
        setBoundaryError('เกิดข้อผิดพลาดในการเชื่อมต่อเครือข่าย');
        setSessionVerified(false);
      }
    }
  };

  useEffect(() => {
    isMountedRef.current = true;
    revalidate();

    let isWindowBlurred = false;

    const handleBlur = () => {
      isWindowBlurred = true;
    };

    const handleFocus = () => {
      if (isWindowBlurred) {
        isWindowBlurred = false;
        revalidate();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isWindowBlurred) {
        isWindowBlurred = false;
        revalidate();
      } else if (document.visibilityState === 'hidden') {
        isWindowBlurred = true;
      }
    };

    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      isMountedRef.current = false;
      ++boundaryGenRef.current;
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      abortControllerRef.current?.abort();
      setSessionVerified(false);
    };
  }, [params.id]);

  if (boundaryError) {
    return (
      <main
        style={{
          minHeight: '100vh',
          backgroundColor: '#f3f4f6',
          padding: '2rem 1rem',
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        }}
      >
        <div
          role="alert"
          id="detail-boundary-error"
          style={{
            maxWidth: '800px',
            margin: '2rem auto',
            padding: '1.25rem',
            borderRadius: '6px',
            backgroundColor: '#fee2e2',
            border: '1px solid #ef4444',
            color: '#991b1b',
            fontSize: '0.875rem',
            textAlign: 'center',
          }}
        >
          <p style={{ margin: '0 0 1rem 0', fontWeight: 600 }}>{boundaryError}</p>
          <Link
            to="/dashboard"
            id="back-dashboard-btn"
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

  if (!sessionVerified) {
    return (
      <div
        id="detail-verifying-boundary"
        style={{ maxWidth: '800px', margin: '2rem auto', padding: '1rem', textAlign: 'center' }}
      >
        <p style={{ color: '#4b5563' }}>กำลังตรวจสอบสิทธิ์การเข้าถึงข้อมูล...</p>
        <Link
          to="/dashboard"
          id="detail-boundary-back-link"
          style={{
            color: '#2563eb',
            textDecoration: 'underline',
            fontSize: '0.875rem',
          }}
        >
          ← กลับสู่แดชบอร์ด
        </Link>
      </div>
    );
  }

  return <AssetDetail key={`${currentActorIdRef.current}-${actorEpoch}-${params.id}`} />;
};

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <Navigate to="/login" replace />,
  },
  {
    path: '/login',
    element: <Login />,
  },
  {
    path: '/dashboard',
    element: <Dashboard />,
  },
  {
    path: '/assets/register',
    element: <AssetRegister />,
  },
  {
    path: '/assets/bulk-register',
    element: <AssetBulkRegister />,
  },
  {
    path: '/assets/search',
    element: <AssetSearch />,
  },
  {
    path: '/assets/:id',
    element: <ProtectedDetailBoundary />,
  },
  {
    path: '/acquisitions/new',
    element: <AcquisitionCreate />,
  },
  {
    path: '/acquisitions/:id',
    element: <AcquisitionDetail />,
  },
  {
    path: '/loans/:id',
    element: <LoanDetail />,
  },
  {
    path: '/admin/references',
    element: <ReferenceAdmin />,
  },
];

export const router = createBrowserRouter(routes);
