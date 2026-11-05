import React, { useEffect, useState } from 'react';

// The three dimensions of an Asset's Permanent Assignment (T4 #25, D7-A; F003 ADR 0001), each
// with separate Legacy text.
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

export const hasReferenceValues = (values: ReferenceContextValues): boolean =>
  REFERENCE_CONTEXT_FIELDS.some((field) => values[field].trim() !== '');

const BANGKOK_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Bangkok',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Today's Asia/Bangkok date as YYYY-MM-DD: the latest Effective Date a fact may have (F003 Q2).
export const bangkokToday = (): string => {
  const parts = Object.fromEntries(BANGKOK_DATE.formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

// An Effective Date (วันที่มีผล): a date, or unknown (ไม่ทราบ).
export interface EffectiveDateChoice {
  date: string;
  unknown: boolean;
}

// F003-T1: the facts an Initial Assignment carries besides its values. A null effectiveDate means
// the user has not chosen one, so it follows the registration's default.
export interface InitialAssignmentDraft {
  effectiveDate: EffectiveDateChoice | null;
  documentReference: string;
  remark: string;
}

export const EMPTY_INITIAL_ASSIGNMENT: InitialAssignmentDraft = { effectiveDate: null, documentReference: '', remark: '' };

// Q11: "ไม่ทราบ" for a legacy registration, so no date is invented; the registration date otherwise.
export const effectiveDateOf = (draft: InitialAssignmentDraft, isLegacy: boolean): EffectiveDateChoice =>
  draft.effectiveDate ?? (isLegacy ? { date: '', unknown: true } : { date: bangkokToday(), unknown: false });

// Why the Effective Date cannot be sent, or null when it can.
export const effectiveDateError = (choice: EffectiveDateChoice): string | null => {
  if (choice.unknown) {
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(choice.date)) {
    return 'กรุณาระบุวันที่มีผล หรือเลือก “ไม่ทราบ”';
  }
  return choice.date > bangkokToday() ? 'วันที่มีผลต้องไม่เกินวันนี้' : null;
};

// What a registration sends for its Initial Assignment: the values with their facts, or nothing
// when no dimension is filled (AR-06).
export const initialAssignmentPayload = (
  values: ReferenceContextValues,
  draft: InitialAssignmentDraft,
  isLegacy: boolean
): Record<string, string | null> => {
  if (!hasReferenceValues(values)) {
    return {};
  }
  const effectiveDate = effectiveDateOf(draft, isLegacy);
  return {
    ...referenceContextPayload(values),
    effective_date: effectiveDate.unknown ? null : effectiveDate.date,
    document_reference: draft.documentReference.trim() || null,
    remark: draft.remark.trim() || null,
  };
};

export const entryLabel = (entry: ReferenceEntry): string =>
  entry.is_active ? entry.name : `${entry.name} (ปิดใช้งาน)`;

export type ReferenceLists = Record<ReferenceKind, ReferenceEntry[]>;

const NO_LISTS: ReferenceLists = { locations: [], 'organization-units': [], persons: [] };

/**
 * Reads a whole reference list page by page, so no entry is cut off, or stops at the first page
 * that fails, with its HTTP status.
 */
export async function fetchReferenceList(
  kind: ReferenceKind,
  includeInactive: boolean,
  signal?: AbortSignal
): Promise<{ ok: true; items: ReferenceEntry[]; canMaintain: boolean } | { ok: false; status: number }> {
  const items: ReferenceEntry[] = [];
  for (;;) {
    const res = await fetch(
      `/references/${kind}?include_inactive=${includeInactive}&limit=500&offset=${items.length}`,
      { credentials: 'include', signal }
    );
    if (!res.ok) {
      return { ok: false, status: res.status };
    }
    const page = await res.json();
    items.push(...page.items);
    if (!page.has_more || page.items.length === 0) {
      return { ok: true, items, canMaintain: page.can_maintain === true };
    }
  }
}

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
        const list = await fetchReferenceList(kind, includeInactive, controller.signal);
        if (!list.ok) {
          throw new Error(`HTTP ${list.status}`);
        }
        return [kind, list.items] as const;
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

export interface InitialAssignmentFieldsProps {
  idPrefix: string;
  effectiveDate: EffectiveDateChoice;
  draft: InitialAssignmentDraft;
  onChange: (draft: InitialAssignmentDraft) => void;
}

/**
 * The Initial Assignment's Effective Date (a date or "ไม่ทราบ"), document reference and remark,
 * shown once a dimension is filled (F003 Q11, Q17, Q5).
 */
export const InitialAssignmentFields: React.FC<InitialAssignmentFieldsProps> = ({
  idPrefix,
  effectiveDate,
  draft,
  onChange,
}) => (
  <div
    id={`${idPrefix}-initial-assignment`}
    style={{ borderTop: '1px solid #e5e7eb', paddingTop: '0.75rem', marginTop: '0.25rem' }}
  >
    <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.8125rem', fontWeight: 600, color: '#374151' }}>
      กำหนดครั้งแรก
    </p>
    <label htmlFor={`${idPrefix}-effective_date`} style={labelStyle}>
      วันที่มีผล
    </label>
    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.25rem' }}>
      <input
        id={`${idPrefix}-effective_date`}
        type="date"
        value={effectiveDate.unknown ? '' : effectiveDate.date}
        max={bangkokToday()}
        disabled={effectiveDate.unknown}
        onChange={(e) => onChange({ ...draft, effectiveDate: { date: e.target.value, unknown: false } })}
        style={{ ...inputStyle, width: 'auto' }}
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.875rem', color: '#374151' }}>
        <input
          id={`${idPrefix}-effective_date_unknown`}
          type="checkbox"
          checked={effectiveDate.unknown}
          onChange={(e) =>
            onChange({
              ...draft,
              effectiveDate: e.target.checked
                ? { date: effectiveDate.date, unknown: true }
                : { date: effectiveDate.date || bangkokToday(), unknown: false },
            })
          }
        />
        ไม่ทราบ
      </label>
    </div>
    <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.75rem', color: '#6b7280' }}>
      วันที่ค่าเหล่านี้เริ่มเป็นจริง ไม่เกินวันนี้ ข้อมูลตกทอดเริ่มที่ “ไม่ทราบ” เพื่อไม่สร้างวันที่ขึ้นเอง
    </p>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
      <div>
        <label htmlFor={`${idPrefix}-document_reference`} style={labelStyle}>
          เอกสารอ้างอิง (ไม่บังคับ)
        </label>
        <input
          id={`${idPrefix}-document_reference`}
          type="text"
          value={draft.documentReference}
          maxLength={500}
          onChange={(e) => onChange({ ...draft, documentReference: e.target.value })}
          placeholder="เช่น เลขที่บันทึกข้อความ"
          style={inputStyle}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-assignment_remark`} style={labelStyle}>
          หมายเหตุ (ไม่บังคับ)
        </label>
        <textarea
          id={`${idPrefix}-assignment_remark`}
          value={draft.remark}
          maxLength={2000}
          rows={2}
          onChange={(e) => onChange({ ...draft, remark: e.target.value })}
          style={inputStyle}
        />
      </div>
    </div>
  </div>
);

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
  // F003-T1: the Initial Assignment's facts, asked for once any dimension is filled.
  initialAssignment?: Omit<InitialAssignmentFieldsProps, 'idPrefix'>;
}

/**
 * Optional Location, OrganizationUnit and Responsible Person, each picked from its list,
 * with the Legacy text kept as recorded when it matches no entry (D7-A, AR-10).
 */
export const ReferenceContextFields: React.FC<ReferenceContextFieldsProps> = ({
  idPrefix,
  legend = 'สถานที่ หน่วยงาน และผู้รับผิดชอบ (ไม่บังคับ)',
  values,
  onChange,
  lists,
  listError,
  currentIds = {},
  disabled = false,
  initialAssignment,
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
    {initialAssignment && hasReferenceValues(values) && (
      <InitialAssignmentFields idPrefix={idPrefix} {...initialAssignment} />
    )}
  </fieldset>
);
