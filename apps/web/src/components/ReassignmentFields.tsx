import React, { useState } from 'react';
import { Link } from 'react-router';
import { AssignmentNoteFields, assignmentNotesPayload, type AssignmentNotes } from './AssignmentNoteFields';
import { ON_LOAN_LABEL, borrowerText, type OnLoan } from './loanFacts';
import {
  REFERENCE_DIMENSIONS,
  entryLabel,
  fieldInputStyle,
  fieldLabelStyle,
  useClearClosedEntries,
  useReferenceLists,
  type ReferenceIdField,
  type ReferenceLists,
} from './ReferenceContextFields';
import { bangkokToday, isBeforeToday, valueText, type AssignmentDimension, type AssignmentValue } from './assignmentFacts';

// The new value chosen for each dimension: no change (''), CLEAR, or an entry id.
type ReassignmentTargets = Record<ReferenceIdField, string>;

const NO_CHANGE: ReassignmentTargets = { location_id: '', organization_unit_id: '', responsible_person_id: '' };

const CLEAR = '__clear__';

// #50 Q15: the Location is never cleared; "location unknown" is a verification finding.
const CLEARABLE = new Set<ReferenceIdField>(['organization_unit_id', 'responsible_person_id']);

// What a Reassignment names: a dimension left at no change stays out, and null clears.
const requestedTargets = (targets: ReassignmentTargets): Partial<Record<ReferenceIdField, string | null>> =>
  Object.fromEntries(
    REFERENCE_DIMENSIONS.filter(({ idField }) => targets[idField] !== '').map(({ idField }) => [
      idField,
      targets[idField] === CLEAR ? null : targets[idField],
    ])
  );

export interface ReassignmentDraft {
  effectiveDate: string;
  setEffectiveDate: (date: string) => void;
  targets: ReassignmentTargets;
  setTargets: React.Dispatch<React.SetStateAction<ReassignmentTargets>>;
  notes: AssignmentNotes;
  setNotes: (notes: AssignmentNotes) => void;
  lists: ReferenceLists;
  listError: string | null;
  offerInactive: boolean;
  requested: Partial<Record<ReferenceIdField, string | null>>;
  // The request's Effective Date, new values and notes.
  requestFields: Record<string, unknown>;
}

/** What a user has entered for one Reassignment, for one Asset or for many. */
export function useReassignmentDraft(actorId: string | null): ReassignmentDraft {
  const [effectiveDate, setEffectiveDate] = useState(bangkokToday);
  const [targets, setTargets] = useState<ReassignmentTargets>(NO_CHANGE);
  const [notes, setNotes] = useState<AssignmentNotes>({ documentReference: '', remark: '' });
  const { lists, error: listError } = useReferenceLists(true, actorId);

  // #50 Q16: deactivated entries are for facts dated before today.
  const offerInactive = isBeforeToday(effectiveDate);
  useClearClosedEntries(offerInactive, lists, setTargets);

  const requested = requestedTargets(targets);
  return {
    effectiveDate,
    setEffectiveDate,
    targets,
    setTargets,
    notes,
    setNotes,
    lists,
    listError,
    offerInactive,
    requested,
    requestFields: { effective_date: effectiveDate, ...requested, ...assignmentNotesPayload(notes) },
  };
}

export interface ReassignmentFieldsProps {
  draft: ReassignmentDraft;
  isLocked: boolean;
  // The value of each dimension on the chosen date, null while it cannot be read. Leave it out for a
  // form over many Assets, whose prior values differ.
  priorValues?: Record<AssignmentDimension, AssignmentValue> | null;
  // The Assets of the form that are On Loan, and who holds each.
  onLoanAssets?: OnLoanAsset[];
}

export interface OnLoanAsset {
  id: string;
  label: string;
  onLoan: OnLoan;
}

/**
 * MR-14, MR-19, #74 Q26: which Assets are On Loan and with whom, and that a Reassignment leaves their
 * Loans as they are. A notice only: it blocks nothing.
 */
const OnLoanNotice: React.FC<{ assets: OnLoanAsset[] }> = ({ assets }) => (
  <div data-testid="assignment-on-loan-notice" style={{ margin: '0 0 0.75rem 0', padding: '0.5rem 0.75rem', fontSize: '0.8125rem', color: '#92400e', backgroundColor: '#fef3c7', borderRadius: '6px' }}>
    <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
      {assets.map(({ id, label, onLoan }) => (
        <li key={id} data-testid={`assignment-on-loan-${id}`}>
          {label} {ON_LOAN_LABEL}โดย {borrowerText(onLoan.borrower)}{' '}
          <Link to={`/loans/${onLoan.loan_id}`} style={{ color: '#2563eb', textDecoration: 'underline' }}>
            ดูการยืม
          </Link>
        </li>
      ))}
    </ul>
    <p style={{ margin: '0.25rem 0 0 0' }}>การย้ายไม่เปลี่ยนผู้ยืมหรือการยืมนี้ เมื่อได้รับคืนให้บันทึกการคืนในหน้าการยืม</p>
  </div>
);

/** The fields of a Reassignment: its Effective Date, a new value for each dimension, and its notes. */
export const ReassignmentFields: React.FC<ReassignmentFieldsProps> = ({ draft, isLocked, priorValues, onLoanAssets = [] }) => {
  const { effectiveDate, setEffectiveDate, targets, setTargets, notes, setNotes, lists, listError, offerInactive } = draft;
  return (
    <fieldset disabled={isLocked} style={{ border: 'none', padding: 0, margin: '0 0 1rem 0' }}>
      <p data-testid="assignment-loan-note" style={{ margin: '0 0 0.75rem 0', fontSize: '0.8125rem', color: '#92400e' }}>
        การยืมชั่วคราวไม่ใช่การย้าย: บันทึกที่นี่เฉพาะเมื่อสถานที่ หน่วยงาน หรือผู้รับผิดชอบเปลี่ยนไปจริง
      </p>
      {onLoanAssets.length > 0 && <OnLoanNotice assets={onLoanAssets} />}
      {listError && (
        <div role="alert" style={{ marginBottom: '0.75rem', fontSize: '0.8125rem', color: '#b91c1c' }}>
          {listError}
        </div>
      )}
      <div style={{ marginBottom: '0.75rem' }}>
        <label htmlFor="assignment-effective_date" style={fieldLabelStyle}>
          วันที่มีผล
        </label>
        <input
          id="assignment-effective_date"
          type="date"
          value={effectiveDate}
          max={bangkokToday()}
          onChange={(e) => setEffectiveDate(e.target.value)}
          style={{ ...fieldInputStyle, width: 'auto' }}
        />
      </div>
      {REFERENCE_DIMENSIONS.map(({ kind: list, idField, entryField, label }) => (
        <div key={idField} style={{ marginBottom: '0.75rem' }}>
          <label htmlFor={`assignment-${idField}`} style={fieldLabelStyle}>
            {label}
          </label>
          {priorValues !== undefined && (
            <div id={`assignment-prior-${entryField}`} style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '0.25rem' }}>
              ค่า ณ วันที่มีผล: {priorValues ? valueText(priorValues[entryField]) : '—'}
            </div>
          )}
          <select
            id={`assignment-${idField}`}
            value={targets[idField]}
            onChange={(e) => setTargets((current) => ({ ...current, [idField]: e.target.value }))}
            style={fieldInputStyle}
          >
            <option value="">— ไม่เปลี่ยน —</option>
            {CLEARABLE.has(idField) && <option value={CLEAR}>ล้างค่า (ไม่ระบุ)</option>}
            {lists[list]
              .filter((entry) => entry.is_active || offerInactive)
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entryLabel(entry)}
                </option>
              ))}
          </select>
        </div>
      ))}
      <AssignmentNoteFields idPrefix="assignment" notes={notes} onChange={setNotes} />
    </fieldset>
  );
};
