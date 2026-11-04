import React, { useEffect, useState } from 'react';

// T4 (#25, D7-A): the three reference dimensions an Asset may name, each with separate legacy text.
export const REFERENCE_DIMENSIONS = [
  {
    kind: 'locations',
    idField: 'location_id',
    legacyField: 'legacy_location_text',
    entryField: 'location',
    label: 'สถานที่ (Location)',
  },
  {
    kind: 'organization-units',
    idField: 'organization_unit_id',
    legacyField: 'legacy_organization_unit_text',
    entryField: 'organization_unit',
    label: 'หน่วยงาน (Organization Unit)',
  },
  {
    kind: 'persons',
    idField: 'responsible_person_id',
    legacyField: 'legacy_responsible_person_text',
    entryField: 'responsible_person',
    label: 'ผู้รับผิดชอบ (Responsible Person)',
  },
] as const;

export type ReferenceKind = (typeof REFERENCE_DIMENSIONS)[number]['kind'];
export type ReferenceIdField = (typeof REFERENCE_DIMENSIONS)[number]['idField'];
export type ReferenceContextField = ReferenceIdField | (typeof REFERENCE_DIMENSIONS)[number]['legacyField'];

export interface ReferenceEntry {
  id: string;
  name: string;
  is_active: boolean;
  version?: number;
}

export interface AssetReferenceContext {
  location: ReferenceEntry | null;
  organization_unit: ReferenceEntry | null;
  responsible_person: ReferenceEntry | null;
  legacy_location_text: string | null;
  legacy_organization_unit_text: string | null;
  legacy_responsible_person_text: string | null;
}

// The reference columns of an Asset record, null when not recorded.
export type AssetReferenceColumns = Record<ReferenceContextField, string | null>;

// Form values, where '' means none.
export type ReferenceContextValues = Record<ReferenceContextField, string>;

export const EMPTY_REFERENCE_CONTEXT: ReferenceContextValues = {
  location_id: '',
  organization_unit_id: '',
  responsible_person_id: '',
  legacy_location_text: '',
  legacy_organization_unit_text: '',
  legacy_responsible_person_text: '',
};

export const REFERENCE_CONTEXT_FIELDS = Object.keys(EMPTY_REFERENCE_CONTEXT) as ReferenceContextField[];

// The context a registration names; blank values are left out, so nothing is invented.
export const referenceContextPayload = (values: ReferenceContextValues): Partial<ReferenceContextValues> =>
  Object.fromEntries(
    REFERENCE_CONTEXT_FIELDS.filter((field) => values[field].trim() !== '').map((field) => [field, values[field].trim()])
  );

export const entryLabel = (entry: ReferenceEntry): string =>
  entry.is_active ? entry.name : `${entry.name} (ปิดใช้งาน)`;

export type ReferenceLists = Record<ReferenceKind, ReferenceEntry[]>;

const NO_LISTS: ReferenceLists = { locations: [], 'organization-units': [], persons: [] };

/**
 * Loads the three reference lists for a verified actor. A new actor key drops the previous
 * actor's lists at once and loads them again; a null key loads nothing.
 */
export function useReferenceLists(
  includeInactive: boolean,
  actorKey: string | null
): { lists: ReferenceLists; error: string | null } {
  const [loaded, setLoaded] = useState<{ key: string; lists: ReferenceLists; error: string | null } | null>(null);

  useEffect(() => {
    if (!actorKey) {
      return;
    }
    const controller = new AbortController();
    Promise.all(
      REFERENCE_DIMENSIONS.map(async ({ kind }) => {
        const res = await fetch(`/references/${kind}?include_inactive=${includeInactive}&limit=500`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return [kind, (await res.json()).items as ReferenceEntry[]] as const;
      })
    )
      .then((entries) => {
        if (!controller.signal.aborted) {
          setLoaded({ key: actorKey, lists: Object.fromEntries(entries) as ReferenceLists, error: null });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoaded({ key: actorKey, lists: NO_LISTS, error: 'ไม่สามารถโหลดรายการข้อมูลอ้างอิงได้' });
        }
      });
    return () => controller.abort();
  }, [includeInactive, actorKey]);

  return loaded && loaded.key === actorKey ? loaded : { lists: NO_LISTS, error: null };
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.875rem',
  fontWeight: 600,
  color: '#374151',
  marginBottom: '0.375rem',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.625rem 0.75rem',
  border: '1px solid #d1d5db',
  borderRadius: '6px',
  fontSize: '0.9375rem',
  boxSizing: 'border-box',
  backgroundColor: '#ffffff',
};

export interface ReferenceContextFieldsProps {
  idPrefix: string;
  legend?: string;
  values: ReferenceContextValues;
  onChange: (field: ReferenceContextField, value: string) => void;
  lists: ReferenceLists;
  listError?: string | null;
  // Entries the Asset names already; they stay selectable after deactivation.
  currentIds?: Partial<Record<ReferenceIdField, string | null>>;
  disabled?: boolean;
}

/**
 * Optional Location, OrganizationUnit and Responsible Person, each picked from its list,
 * with the legacy text kept as recorded when it matches no entry (D7-A, AR-10).
 */
export const ReferenceContextFields: React.FC<ReferenceContextFieldsProps> = ({
  idPrefix,
  legend = 'ข้อมูลอ้างอิง (ไม่บังคับ)',
  values,
  onChange,
  lists,
  listError,
  currentIds = {},
  disabled = false,
}) => (
  <fieldset
    id={`${idPrefix}-reference-context`}
    disabled={disabled}
    style={{ border: '1px solid #e5e7eb', borderRadius: '6px', padding: '1rem', margin: '0 0 1.5rem 0' }}
  >
    <legend style={{ fontSize: '0.875rem', fontWeight: 600, color: '#374151', padding: '0 0.25rem' }}>
      {legend}
    </legend>
    <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.75rem', color: '#6b7280' }}>
      เลือกจากรายการกลาง หรือบันทึกข้อความเดิมตามจริงเมื่อไม่ตรงกับรายการ ครุภัณฑ์ใช้ร่วมกันไม่ต้องระบุผู้รับผิดชอบ
    </p>
    {listError && (
      <div role="alert" style={{ marginBottom: '0.75rem', fontSize: '0.8125rem', color: '#b91c1c' }}>
        {listError}
      </div>
    )}
    {REFERENCE_DIMENSIONS.map(({ kind, idField, legacyField, label }) => (
      <div
        key={kind}
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '0.75rem' }}
      >
        <div>
          <label htmlFor={`${idPrefix}-${idField}`} style={labelStyle}>
            {label}
          </label>
          <select
            id={`${idPrefix}-${idField}`}
            value={values[idField]}
            onChange={(e) => onChange(idField, e.target.value)}
            style={inputStyle}
          >
            <option value="">— ไม่ระบุ —</option>
            {lists[kind]
              .filter((entry) => entry.is_active || entry.id === currentIds[idField])
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entryLabel(entry)}
                </option>
              ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-${legacyField}`} style={labelStyle}>
            ข้อความเดิม
          </label>
          <input
            id={`${idPrefix}-${legacyField}`}
            type="text"
            value={values[legacyField]}
            maxLength={500}
            onChange={(e) => onChange(legacyField, e.target.value)}
            placeholder="เว้นว่างได้"
            style={inputStyle}
          />
        </div>
      </div>
    ))}
  </fieldset>
);
