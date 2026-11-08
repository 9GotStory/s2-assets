import React from 'react';
import { fieldInputStyle, fieldLabelStyle } from './ReferenceContextFields';

// The optional text an assignment fact carries (#50 Q5).
export interface AssignmentNotes {
  documentReference: string;
  remark: string;
}

export const assignmentNotesPayload = (notes: AssignmentNotes): { document_reference: string | null; remark: string | null } => ({
  document_reference: notes.documentReference.trim() || null,
  remark: notes.remark.trim() || null,
});

export interface AssignmentNoteFieldsProps {
  idPrefix: string;
  notes: AssignmentNotes;
  onChange: (notes: AssignmentNotes) => void;
}

export const AssignmentNoteFields: React.FC<AssignmentNoteFieldsProps> = ({ idPrefix, notes, onChange }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
    <div>
      <label htmlFor={`${idPrefix}-document_reference`} style={fieldLabelStyle}>
        เอกสารอ้างอิง (ไม่บังคับ)
      </label>
      <input
        id={`${idPrefix}-document_reference`}
        type="text"
        value={notes.documentReference}
        maxLength={500}
        onChange={(e) => onChange({ ...notes, documentReference: e.target.value })}
        placeholder="เช่น เลขที่บันทึกข้อความ"
        style={fieldInputStyle}
      />
    </div>
    <div>
      <label htmlFor={`${idPrefix}-assignment_remark`} style={fieldLabelStyle}>
        หมายเหตุ (ไม่บังคับ)
      </label>
      <textarea
        id={`${idPrefix}-assignment_remark`}
        value={notes.remark}
        maxLength={2000}
        rows={2}
        onChange={(e) => onChange({ ...notes, remark: e.target.value })}
        style={fieldInputStyle}
      />
    </div>
  </div>
);
