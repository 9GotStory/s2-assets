import React, { useState } from 'react';
import { fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';
import type { ListEntry } from './materialFacts';

// What adding an entry ended in: nothing yet, a message to show, or the request still out.
type AddState = { status: 'idle' } | { status: 'sending' } | { status: 'message'; text: string; isError: boolean };

export interface ListEntryAddFieldProps {
  // Names the field `${id}`, its button `${id}-add` and its message `${id}-message`.
  id: string;
  // The list's path, such as /units or /brands.
  path: string;
  // What an entry of the list is called, such as หน่วยนับ or ยี่ห้อ.
  concept: string;
  addLabel: string;
  placeholder: string;
  csrfToken: string | null;
  disabled: boolean;
  // Chooses the entry added, or the active entry already holding the name.
  onAdded: (entry: ListEntry) => Promise<void>;
}

/**
 * Adds an entry to a list of the Stock Material catalog straight from a form (#175 Q15, P5): a Unit (F008-T1), a
 * Brand or a Material Category (F008-T4). A name already in the list is chosen instead when it is active; an Inactive
 * one is reactivated from the maintenance page (F008-T8).
 */
export const ListEntryAddField: React.FC<ListEntryAddFieldProps> = ({ id, path, concept, addLabel, placeholder, csrfToken, disabled, onAdded }) => {
  const [name, setName] = useState('');
  const [state, setState] = useState<AddState>({ status: 'idle' });

  const add = async () => {
    if (name.trim() === '') {
      setState({ status: 'message', text: `กรุณากรอกชื่อ${concept}`, isError: true });
      return;
    }
    setState({ status: 'sending' });
    const retryToken = crypto.randomUUID();
    let res: Response;
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-retry-token': retryToken, ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
        credentials: 'include',
        body: JSON.stringify({ name: name.trim(), retry_token: retryToken }),
      });
    } catch {
      setState({ status: 'message', text: 'เกิดข้อผิดพลาดในการเชื่อมต่อเครือข่าย กรุณาลองใหม่', isError: true });
      return;
    }
    const body = await res.json().catch(() => null);
    if (res.status === 201) {
      await onAdded(body);
      setName('');
      setState({ status: 'message', text: `เพิ่ม${concept} "${body.name}" แล้ว`, isError: false });
      return;
    }
    if (res.status === 409 && body?.code === 'DUPLICATE_NAME' && body.entry) {
      const entry: ListEntry = body.entry;
      if (entry.is_active) {
        await onAdded(entry);
        setName('');
        setState({ status: 'message', text: `มี${concept} "${entry.name}" อยู่แล้ว เลือกให้แล้ว`, isError: false });
      } else {
        setState({ status: 'message', text: `${concept} "${entry.name}" ถูกหยุดใช้อยู่ ใช้ไม่ได้จนกว่าจะเปิดใช้อีกครั้ง`, isError: true });
      }
      return;
    }
    setState({ status: 'message', text: body?.message || `ไม่สามารถเพิ่ม${concept}ได้`, isError: true });
  };

  return (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.5rem' }}>
      <label htmlFor={id} style={{ fontSize: '0.875rem', color: '#4b5563' }}>
        ไม่มีในรายการ:
      </label>
      <input
        id={id}
        type="text"
        value={name}
        maxLength={200}
        placeholder={placeholder}
        disabled={disabled || state.status === 'sending'}
        onChange={(e) => setName(e.target.value)}
        style={{ ...fieldInputStyle, width: 'auto', flex: '1 1 10rem' }}
      />
      <button
        type="button"
        id={`${id}-add`}
        disabled={disabled || state.status === 'sending'}
        onClick={() => void add()}
        style={{ padding: '0.5rem 0.875rem', backgroundColor: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.875rem' }}
      >
        {addLabel}
      </button>
      {state.status === 'message' && (
        <span role={state.isError ? 'alert' : 'status'} data-testid={`${id}-message`} style={{ flexBasis: '100%', fontSize: '0.875rem', color: state.isError ? '#991b1b' : '#166534' }}>
          {state.text}
        </span>
      )}
    </div>
  );
};

export interface ListEntrySelectProps {
  id: string;
  label: string;
  // The list, Inactive entries included.
  entries: ListEntry[];
  // The chosen entry's id, or empty for none.
  value: string;
  onChange: (value: string) => void;
  // Added under the select, such as a ListEntryAddField.
  children?: React.ReactNode;
}

/**
 * An optional choice from a list of the Stock Material catalog, such as the Brand or the Material Category (F008-T4):
 * a new choice is an active entry (#175 Q21), and an entry already chosen stays offered as itself.
 */
export const ListEntrySelect: React.FC<ListEntrySelectProps> = ({ id, label, entries, value, onChange, children }) => {
  const options = entries.filter((entry) => entry.is_active || entry.id === value);
  return (
    <div style={{ marginBottom: '0.75rem' }}>
      <label htmlFor={id} style={fieldLabelStyle}>
        {label} (ไม่บังคับ)
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} style={fieldInputStyle}>
        <option value="">-- ไม่ระบุ{label} --</option>
        {options.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.name}
          </option>
        ))}
      </select>
      {children}
    </div>
  );
};
