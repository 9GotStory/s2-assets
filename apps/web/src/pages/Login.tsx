import React, { useState } from 'react';
import { useNavigate } from 'react-router';

export interface SafeUser {
  id: string;
  username: string;
  is_active: boolean;
  created_at?: string | Date;
  updated_at?: string | Date;
}

export interface LoginResponse {
  user: SafeUser;
}

export const Login: React.FC = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (isLoading) {
      return;
    }

    const trimmedUsername = username.trim();
    if (!trimmedUsername || !password) {
      setErrorMessage('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน');
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const response = await fetch('/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          username: trimmedUsername,
          password,
        }),
      });

      if (response.ok) {
        // Successful login: session cookie is set automatically by the server.
        // Navigate to the protected dashboard.
        navigate('/dashboard');
        return;
      }

      // Safe error handling without leaking server internals or raw messages
      if (response.status === 401 || response.status === 403) {
        setErrorMessage('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง หรือบัญชีถูกระงับการใช้งาน');
      } else if (response.status === 400) {
        setErrorMessage('ข้อมูลการเข้าสู่ระบบไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง');
      } else {
        setErrorMessage('ไม่สามารถเข้าสู่ระบบได้ กรุณาลองใหม่อีกครั้งในภายหลัง');
      }
    } catch {
      // Network or unexpected failure
      setErrorMessage('เกิดข้อผิดพลาดในการเชื่อมต่อกับเซิร์ฟเวอร์ กรุณาลองใหม่อีกครั้ง');
    } finally {
      setIsLoading(false);
    }
  };

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
        style={{
          width: '100%',
          maxWidth: '400px',
          backgroundColor: '#ffffff',
          borderRadius: '8px',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
          padding: '2rem',
          boxSizing: 'border-box',
        }}
      >
        <h1
          style={{
            fontSize: '1.5rem',
            fontWeight: 600,
            marginBottom: '1.5rem',
            textAlign: 'center',
            color: '#1a1a1a',
          }}
        >
          เข้าสู่ระบบ
        </h1>

        {errorMessage && (
          <div
            role="alert"
            aria-live="polite"
            style={{
              padding: '0.75rem',
              marginBottom: '1rem',
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
          <div style={{ marginBottom: '1rem' }}>
            <label
              htmlFor="username"
              style={{
                display: 'block',
                marginBottom: '0.5rem',
                fontSize: '0.875rem',
                fontWeight: 500,
                color: '#374151',
              }}
            >
              ชื่อผู้ใช้งาน
            </label>
            <input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              required
              disabled={isLoading}
              value={username}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUsername(e.target.value)}
              style={{
                width: '100%',
                padding: '0.625rem',
                border: '1px solid #d1d5db',
                borderRadius: '4px',
                fontSize: '1rem',
                boxSizing: 'border-box',
                backgroundColor: isLoading ? '#f3f4f6' : '#ffffff',
              }}
            />
          </div>

          <div style={{ marginBottom: '1.5rem' }}>
            <label
              htmlFor="password"
              style={{
                display: 'block',
                marginBottom: '0.5rem',
                fontSize: '0.875rem',
                fontWeight: 500,
                color: '#374151',
              }}
            >
              รหัสผ่าน
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              disabled={isLoading}
              value={password}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
              style={{
                width: '100%',
                padding: '0.625rem',
                border: '1px solid #d1d5db',
                borderRadius: '4px',
                fontSize: '1rem',
                boxSizing: 'border-box',
                backgroundColor: isLoading ? '#f3f4f6' : '#ffffff',
              }}
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            aria-busy={isLoading}
            style={{
              width: '100%',
              padding: '0.75rem',
              backgroundColor: isLoading ? '#93c5fd' : '#2563eb',
              color: '#ffffff',
              border: 'none',
              borderRadius: '4px',
              fontSize: '1rem',
              fontWeight: 500,
              cursor: isLoading ? 'not-allowed' : 'pointer',
              transition: 'background-color 0.2s',
            }}
          >
            {isLoading ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
          </button>
        </form>
      </div>
    </main>
  );
};

export default Login;
