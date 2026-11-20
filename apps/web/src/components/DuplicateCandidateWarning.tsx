import React from 'react';
import { Link } from 'react-router';
import { conflictActionStyle, conflictBoxStyle } from './AssignmentConflictWarning';
import {
  ACTIVE_LABEL,
  BASE_UNIT_LABEL,
  BRAND_LABEL,
  DIFFERENT_STOCK_MATERIAL_LABEL,
  DUPLICATE_CANDIDATE_LABEL,
  INACTIVE_LABEL,
  MODEL_LABEL,
  SPECIFICATION_LABEL,
  type DuplicateCandidatesFound,
} from './materialFacts';

const cellStyle: React.CSSProperties = { padding: '0.25rem 0.5rem', verticalAlign: 'top', textAlign: 'left' };

export interface DuplicateCandidateWarningProps {
  found: DuplicateCandidatesFound;
  onConfirm: () => void;
  onBack: () => void;
}

/**
 * F008-T5 (#181): the Duplicate Candidates (รายการที่อาจซ้ำ) a create or a Material Correction was refused with, at most
 * 50 under how many there are (P4), each with what tells it apart, Inactive ones included (#175 MC-17, Q12). Nothing is saved until the Supply Officer
 * confirms "เป็นคนละรายการ"; the system never merges (MC-22).
 */
export const DuplicateCandidateWarning: React.FC<DuplicateCandidateWarningProps> = ({ found, onConfirm, onBack }) => (
  <div role="alert" data-testid="duplicate-candidate-warning" style={conflictBoxStyle}>
    <div style={{ fontWeight: 600 }}>
      พบ{DUPLICATE_CANDIDATE_LABEL} {found.total_count} รายการ
    </div>
    <div style={{ marginTop: '0.25rem' }}>ถ้าเป็นของสิ่งเดียวกัน ให้ใช้รายการเดิมแทน</div>
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', margin: '0.5rem 0', fontSize: '0.8125rem' }}>
        <thead>
          <tr>
            <th style={cellStyle}>ชื่อวัสดุ</th>
            <th style={cellStyle}>{BRAND_LABEL}</th>
            <th style={cellStyle}>{MODEL_LABEL}</th>
            <th style={cellStyle}>{SPECIFICATION_LABEL}</th>
            <th style={cellStyle}>{BASE_UNIT_LABEL}</th>
            <th style={cellStyle}>สถานะ</th>
          </tr>
        </thead>
        <tbody>
          {found.candidates.map((candidate) => (
            <tr key={candidate.id} data-testid={`duplicate-candidate-${candidate.id}`}>
              <td style={cellStyle}>
                <Link to={`/stock-materials/${encodeURIComponent(candidate.id)}`} target="_blank" rel="noreferrer">
                  {candidate.name}
                </Link>
              </td>
              <td style={cellStyle}>{candidate.brand?.name ?? '-'}</td>
              <td style={cellStyle}>{candidate.model ?? '-'}</td>
              <td style={{ ...cellStyle, whiteSpace: 'pre-line' }}>{candidate.specification ?? '-'}</td>
              <td style={cellStyle}>{candidate.base_unit.name}</td>
              <td style={cellStyle}>{candidate.is_active ? ACTIVE_LABEL : INACTIVE_LABEL}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      <button type="button" id="duplicate-candidate-confirm" onClick={onConfirm} style={{ ...conflictActionStyle, backgroundColor: '#b45309', color: '#ffffff', border: 'none' }}>
        {DIFFERENT_STOCK_MATERIAL_LABEL}
      </button>
      <button type="button" id="duplicate-candidate-back" onClick={onBack} style={{ ...conflictActionStyle, backgroundColor: '#ffffff', color: '#92400e', border: '1px solid #f59e0b' }}>
        กลับไปแก้ไข
      </button>
    </div>
  </div>
);
