import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { REFERENCE_DIMENSIONS, type ReferenceEntry, type ReferenceKind } from '../components/ReferenceContextFields';

const WRITE_ERRORS: Record<string, string> = {
  DUPLICATE_NAME: 'มีชื่อนี้อยู่แล้วในรายการ (ไม่นับตัวพิมพ์เล็ก-ใหญ่และช่องว่างหน้า-หลัง)',
  VERSION_CONFLICT: 'รายการถูกแก้ไขโดยผู้อื่นแล้ว ระบบโหลดรายการล่าสุดให้ กรุณาตรวจสอบอีกครั้ง',
  NOT_FOUND: 'ไม่พบรายการนี้ ระบบโหลดรายการล่าสุดให้แล้ว',
  VALIDATION_FAILED: 'ชื่อต้องไม่ว่าง ยาวไม่เกิน 200 ตัวอักษร และไม่มีอักขระควบคุม',
  FORBIDDEN: 'คุณไม่มีสิทธิ์ดูแลรายการข้อมูลอ้างอิง (403 Forbidden)',
};

const buttonStyle = (background: string, color = '#ffffff'): React.CSSProperties => ({
  padding: '0.375rem 0.75rem',
  backgroundColor: background,
  color,
  border: background === '#ffffff' ? '1px solid #d1d5db' : 'none',
  borderRadius: '4px',
  fontSize: '0.8125rem',
  fontWeight: 500,
  cursor: 'pointer',
});

const inputStyle: React.CSSProperties = {
  padding: '0.5rem 0.75rem',
  border: '1px solid #d1d5db',
  borderRadius: '4px',
  fontSize: '0.875rem',
  boxSizing: 'border-box',
};

/**
 * T4 (#25, D7-A): the flat Location, OrganizationUnit and Responsible Person lists. Every registry
 * viewer reads them; a reference:maintain holder (ADMINISTRATOR, D3) adds, renames, deactivates
 * and reactivates entries. Nothing is deleted.
 */
export const ReferenceAdmin: React.FC = () => {
  const navigate = useNavigate();
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [actorId, setActorId] = useState<string | null>(null);
  const [kind, setKind] = useState<ReferenceKind>('locations');
  const [entries, setEntries] = useState<ReferenceEntry[] | null>(null);
  const [canMaintain, setCanMaintain] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/auth/session-check', { credentials: 'include', signal: controller.signal })
      .then(async (res) => {
        const data = res.ok ? await res.json() : null;
        if (!data?.user?.id) {
          navigate('/login', { replace: true });
          return;
        }
        setCsrfToken(data.csrfToken || null);
        setActorId(data.user.id);
      })
      .catch((err: unknown) => {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          navigate('/login', { replace: true });
        }
      });
    return () => controller.abort();
  }, [navigate]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const res = await fetch(`/references/${kind}?include_inactive=true&limit=500`, {
        credentials: 'include',
        signal,
      });
      if (signal?.aborted) return;
      if (res.status === 401) {
        navigate('/login', { replace: true });
        return;
      }
      if (!res.ok) {
        setEntries([]);
        setCanMaintain(false);
        setMessage({
          tone: 'error',
          text:
            res.status === 403
              ? 'คุณไม่มีสิทธิ์ดูรายการข้อมูลอ้างอิง (403 Forbidden)'
              : 'ไม่สามารถโหลดรายการข้อมูลอ้างอิงได้',
        });
        return;
      }
      const data = await res.json();
      if (signal?.aborted) return;
      setEntries(data.items);
      setCanMaintain(data.can_maintain === true);
    },
    [kind, navigate]
  );

  useEffect(() => {
    if (!actorId) return;
    const controller = new AbortController();
    setEntries(null);
    setEditing(null);
    load(controller.signal).catch(() => {
      if (!controller.signal.aborted) {
        setEntries([]);
        setMessage({ tone: 'error', text: 'เกิดข้อผิดพลาดในการเชื่อมต่อเครือข่าย' });
      }
    });
    return () => controller.abort();
  }, [actorId, load]);

  // Sends one maintenance write, then shows the list as the server now holds it.
  const write = async (url: string, body: unknown, success: string): Promise<boolean> => {
    setIsBusy(true);
    setMessage(null);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) {
        headers['x-csrf-token'] = csrfToken;
      }
      const res = await fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
      if (res.status === 401) {
        navigate('/login', { replace: true });
        return false;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setMessage({ tone: 'error', text: WRITE_ERRORS[err?.code] ?? 'บันทึกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' });
        if (err?.code === 'VERSION_CONFLICT' || err?.code === 'NOT_FOUND') {
          setEditing(null);
          await load();
        }
        return false;
      }
      setMessage({ tone: 'success', text: success });
      await load();
      return true;
    } catch {
      // The write may or may not have landed; show the list as it now is.
      setMessage({ tone: 'error', text: 'เกิดข้อผิดพลาดในการเชื่อมต่อเครือข่าย กรุณาตรวจสอบรายการก่อนลองอีกครั้ง' });
      await load().catch(() => {});
      return false;
    } finally {
      setIsBusy(false);
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await write(`/references/${kind}`, { name: newName }, 'เพิ่มรายการแล้ว')) {
      setNewName('');
    }
  };

  const handleRename = async (entry: ReferenceEntry) => {
    if (!editing) return;
    if (await write(`/references/${kind}/${entry.id}`, { expected_version: entry.version, name: editing.name }, 'แก้ชื่อแล้ว')) {
      setEditing(null);
    }
  };

  const handleToggle = (entry: ReferenceEntry) =>
    write(
      `/references/${kind}/${entry.id}`,
      { expected_version: entry.version, is_active: !entry.is_active },
      entry.is_active ? 'ปิดใช้งานแล้ว' : 'เปิดใช้งานแล้ว'
    );

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
          maxWidth: '900px',
          margin: '0 auto',
          backgroundColor: '#ffffff',
          borderRadius: '8px',
          padding: '2rem',
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
        }}
      >
        <nav style={{ marginBottom: '1rem' }}>
          <Link to="/dashboard" id="reference-back-link" style={{ color: '#2563eb', fontSize: '0.875rem' }}>
            ← กลับสู่แดชบอร์ด
          </Link>
        </nav>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', margin: '0 0 0.5rem 0' }}>
          รายการข้อมูลอ้างอิง (Reference Lists)
        </h1>
        <p style={{ margin: '0 0 1.5rem 0', fontSize: '0.875rem', color: '#6b7280' }}>
          รายการกลางแบบไม่มีลำดับชั้นของสถานที่ หน่วยงาน และผู้รับผิดชอบ ผู้ดูแลระบบเพิ่ม แก้ชื่อ และปิดหรือเปิดใช้งานรายการได้
          โดยไม่มีการลบ
        </p>

        <div role="tablist" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
          {REFERENCE_DIMENSIONS.map(({ kind: tabKind, label }) => (
            <button
              key={tabKind}
              type="button"
              role="tab"
              id={`reference-tab-${tabKind}`}
              aria-selected={kind === tabKind}
              onClick={() => {
                setKind(tabKind);
                setMessage(null);
              }}
              style={buttonStyle(kind === tabKind ? '#2563eb' : '#ffffff', kind === tabKind ? '#ffffff' : '#374151')}
            >
              {label}
            </button>
          ))}
        </div>

        {message && (
          <div
            role={message.tone === 'error' ? 'alert' : 'status'}
            id="reference-message"
            style={{
              padding: '0.75rem 1rem',
              marginBottom: '1rem',
              borderRadius: '6px',
              fontSize: '0.875rem',
              backgroundColor: message.tone === 'error' ? '#fee2e2' : '#ecfdf5',
              color: message.tone === 'error' ? '#991b1b' : '#065f46',
            }}
          >
            {message.text}
          </div>
        )}

        {entries !== null && !canMaintain && (
          <p data-testid="reference-read-only-notice" style={{ fontSize: '0.875rem', color: '#6b7280' }}>
            ผู้ใช้ปัจจุบันดูรายการได้อย่างเดียว การเพิ่มหรือแก้ไขรายการทำได้เฉพาะผู้ดูแลระบบ
          </p>
        )}

        {canMaintain && (
          <form
            id="reference-add-form"
            onSubmit={handleAdd}
            style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', marginBottom: '1.25rem' }}
          >
            <div style={{ flex: 1 }}>
              <label
                htmlFor="reference-new-name"
                style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, color: '#374151', marginBottom: '0.25rem' }}
              >
                เพิ่มรายการใหม่
              </label>
              <input
                id="reference-new-name"
                type="text"
                value={newName}
                maxLength={200}
                onChange={(e) => setNewName(e.target.value)}
                style={{ ...inputStyle, width: '100%' }}
              />
            </div>
            <button
              type="submit"
              id="reference-add-btn"
              disabled={isBusy || newName.trim() === ''}
              style={buttonStyle(isBusy || newName.trim() === '' ? '#9ca3af' : '#2563eb')}
            >
              เพิ่ม
            </button>
          </form>
        )}

        {entries === null ? (
          <div role="status" style={{ color: '#6b7280', fontSize: '0.875rem' }}>
            กำลังโหลดรายการ...
          </div>
        ) : entries.length === 0 ? (
          <div
            id="reference-empty"
            style={{
              padding: '2rem 1rem',
              textAlign: 'center',
              border: '1px dashed #d1d5db',
              borderRadius: '6px',
              color: '#6b7280',
              fontSize: '0.875rem',
            }}
          >
            ยังไม่มีรายการ
          </div>
        ) : (
          <table id="reference-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
            <thead>
              <tr style={{ backgroundColor: '#f9fafb', borderBottom: '2px solid #e5e7eb', textAlign: 'left' }}>
                <th style={{ padding: '0.625rem 0.75rem' }}>ชื่อ</th>
                <th style={{ padding: '0.625rem 0.75rem' }}>สถานะ</th>
                {canMaintain && <th style={{ padding: '0.625rem 0.75rem' }}>การดูแล</th>}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} data-testid={`reference-row-${entry.id}`} style={{ borderBottom: '1px solid #e5e7eb' }}>
                  <td style={{ padding: '0.625rem 0.75rem', color: '#111827' }}>
                    {editing?.id === entry.id ? (
                      <input
                        id={`reference-rename-${entry.id}`}
                        type="text"
                        aria-label={`ชื่อใหม่ของ ${entry.name}`}
                        value={editing.name}
                        maxLength={200}
                        onChange={(e) => setEditing({ id: entry.id, name: e.target.value })}
                        style={{ ...inputStyle, width: '100%' }}
                      />
                    ) : (
                      entry.name
                    )}
                  </td>
                  <td style={{ padding: '0.625rem 0.75rem', color: entry.is_active ? '#065f46' : '#9ca3af' }}>
                    {entry.is_active ? 'ใช้งาน' : 'ปิดใช้งาน'}
                  </td>
                  {canMaintain && (
                    <td style={{ padding: '0.625rem 0.75rem', display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
                      {editing?.id === entry.id ? (
                        <>
                          <button
                            type="button"
                            id={`reference-save-${entry.id}`}
                            disabled={isBusy || editing.name.trim() === ''}
                            onClick={() => handleRename(entry)}
                            style={buttonStyle('#2563eb')}
                          >
                            บันทึกชื่อ
                          </button>
                          <button type="button" onClick={() => setEditing(null)} style={buttonStyle('#ffffff', '#374151')}>
                            ยกเลิก
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            id={`reference-edit-${entry.id}`}
                            disabled={isBusy}
                            onClick={() => setEditing({ id: entry.id, name: entry.name })}
                            style={buttonStyle('#ffffff', '#374151')}
                          >
                            แก้ชื่อ
                          </button>
                          <button
                            type="button"
                            id={`reference-toggle-${entry.id}`}
                            disabled={isBusy}
                            onClick={() => handleToggle(entry)}
                            style={buttonStyle(entry.is_active ? '#b45309' : '#059669')}
                          >
                            {entry.is_active ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}
                          </button>
                        </>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
};

export default ReferenceAdmin;
