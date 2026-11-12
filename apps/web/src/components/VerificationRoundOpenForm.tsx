import React, { useState } from 'react';
import { Link } from 'react-router';
import { LoanSaveForm } from './LoanSaveForm';
import { entryLabel, fieldInputStyle, fieldLabelStyle, type ReferenceEntry, type ReferenceLists } from './ReferenceContextFields';
import { thaiDate } from './assignmentFacts';
import { FISCAL_YEAR_LABEL, OPEN_VERIFICATION_ROUND_LABEL, WHOLE_REGISTER_LABEL, roundLabel, type OpenVerificationRound } from './verificationFacts';

export interface VerificationRoundOpenFormProps {
  lists: ReferenceLists;
  listsError: string | null;
  csrfToken: string | null;
  onOpened: () => Promise<void>;
  onCancel: () => void;
  onPermissionRevoked?: (statusCode?: number) => void;
}

const fieldStyle: React.CSSProperties = { marginBottom: '0.75rem' };

// The entries of one list a Round covers; none chosen leaves that dimension unfiltered (#125 Q3).
const FilterChoices: React.FC<{ idPrefix: string; legend: string; entries: ReferenceEntry[]; chosen: string[]; onChange: (chosen: string[]) => void }> = ({
  idPrefix,
  legend,
  entries,
  chosen,
  onChange,
}) => (
  <fieldset style={{ border: '1px solid #e5e7eb', borderRadius: '6px', padding: '0.5rem 0.75rem', margin: '0 0 0.75rem 0', minWidth: 0 }}>
    <legend style={{ fontSize: '0.875rem', fontWeight: 600, color: '#374151' }}>{legend}</legend>
    {entries.length === 0 ? (
      <span style={{ fontSize: '0.875rem', color: '#6b7280' }}>ไม่มีรายการ</span>
    ) : (
      <div style={{ maxHeight: '12rem', overflowY: 'auto', display: 'grid', gap: '0.25rem' }}>
        {entries.map((entry) => (
          <label key={entry.id} style={{ fontSize: '0.875rem', color: '#111827' }}>
            <input
              type="checkbox"
              id={`${idPrefix}-${entry.id}`}
              checked={chosen.includes(entry.id)}
              onChange={(e) => onChange(e.target.checked ? [...chosen, entry.id] : chosen.filter((id) => id !== entry.id))}
            />{' '}
            {entryLabel(entry)}
          </label>
        ))}
      </div>
    )}
  </fieldset>
);

/**
 * "เปิดรอบตรวจ": opens a Verification Round over the whole register, or over the Assets whose Current Assignment
 * is in chosen OrganizationUnits and Locations (F006-T1, #125 Q2, Q3). The server decides again everything this
 * form checks, and takes the start date from its own clock.
 */
export const VerificationRoundOpenForm: React.FC<VerificationRoundOpenFormProps> = ({ lists, listsError, csrfToken, onOpened, onCancel, onPermissionRevoked }) => {
  const [name, setName] = useState('');
  const [fiscalYear, setFiscalYear] = useState('');
  const [notes, setNotes] = useState('');
  const [organizationUnitIds, setOrganizationUnitIds] = useState<string[]>([]);
  const [locationIds, setLocationIds] = useState<string[]>([]);

  const requestError = (): string | null => {
    if (name.trim() === '') {
      return 'กรุณากรอกชื่อรอบตรวจ';
    }
    if (!/^[1-9]\d{3}$/.test(fiscalYear.trim())) {
      return `กรุณากรอก${FISCAL_YEAR_LABEL}เป็นปี พ.ศ. 4 หลัก`;
    }
    return null;
  };

  const requestBody = () => ({
    name: name.trim(),
    fiscal_year: Number(fiscalYear.trim()),
    notes: notes.trim() || null,
    organization_unit_ids: organizationUnitIds,
    location_ids: locationIds,
  });

  return (
    <LoanSaveForm
      idPrefix="verification-open"
      heading={OPEN_VERIFICATION_ROUND_LABEL}
      saveUrl="/verification-rounds"
      csrfToken={csrfToken}
      requestError={requestError}
      requestBody={requestBody}
      refusedList={(body) => {
        if (body?.code === 'ANOTHER_VERIFICATION_ROUND_OPEN') {
          const openRound = body.open_round as OpenVerificationRound;
          return (
            <>
              เปิดรอบตรวจไม่ได้ เพราะมีรอบที่เปิดอยู่แล้ว: <Link to={`/verification-rounds/${openRound.id}`}>{roundLabel(openRound)}</Link> เริ่ม{' '}
              <time dateTime={openRound.start_date}>{thaiDate(openRound.start_date)}</time>
            </>
          );
        }
        return body?.code === 'EMPTY_VERIFICATION_SCOPE' ? <>เปิดรอบตรวจไม่ได้ เพราะไม่มีครุภัณฑ์ที่ตรงกับหน่วยงานและสถานที่ที่เลือก</> : null;
      }}
      forbiddenMessage="คุณไม่มีสิทธิ์เปิดรอบตรวจ"
      refusedMessage="ไม่สามารถเปิดรอบตรวจได้"
      onSaved={onOpened}
      onCancel={onCancel}
      onPermissionRevoked={onPermissionRevoked}
    >
      {(isLocked) => (
        <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0', minWidth: 0 }}>
          <div style={fieldStyle}>
            <label htmlFor="verification-open-name" style={fieldLabelStyle}>
              ชื่อรอบตรวจ
            </label>
            <input id="verification-open-name" type="text" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} style={fieldInputStyle} />
          </div>
          <div style={fieldStyle}>
            <label htmlFor="verification-open-fiscal_year" style={fieldLabelStyle}>
              {FISCAL_YEAR_LABEL} (พ.ศ.)
            </label>
            <input
              id="verification-open-fiscal_year"
              type="text"
              inputMode="numeric"
              value={fiscalYear}
              maxLength={4}
              onChange={(e) => setFiscalYear(e.target.value)}
              style={{ ...fieldInputStyle, maxWidth: '10rem' }}
            />
          </div>
          <div style={fieldStyle}>
            <label htmlFor="verification-open-notes" style={fieldLabelStyle}>
              หมายเหตุ เช่น รายชื่อคณะกรรมการ (ไม่บังคับ)
            </label>
            <textarea id="verification-open-notes" value={notes} maxLength={2000} rows={3} onChange={(e) => setNotes(e.target.value)} style={fieldInputStyle} />
          </div>
          <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.875rem', color: '#4b5563' }}>
            ไม่เลือกหน่วยงานหรือสถานที่ใดเลย หมายถึง{WHOLE_REGISTER_LABEL} ครุภัณฑ์ที่หน่วยงานหรือสถานที่ว่างหรือเป็นข้อความเดิมจะไม่อยู่ในรอบเมื่อกรองด้านนั้น
          </p>
          {listsError && (
            <p role="alert" style={{ margin: '0 0 0.5rem 0', fontSize: '0.875rem', color: '#991b1b' }}>
              {listsError}
            </p>
          )}
          <FilterChoices idPrefix="verification-open-organization-unit" legend="หน่วยงาน" entries={lists['organization-units']} chosen={organizationUnitIds} onChange={setOrganizationUnitIds} />
          <FilterChoices idPrefix="verification-open-location" legend="สถานที่" entries={lists.locations} chosen={locationIds} onChange={setLocationIds} />
        </fieldset>
      )}
    </LoanSaveForm>
  );
};
