import React from 'react';
import { Link } from 'react-router';
import { RETIRED_LABEL, RETIREMENT_SECTION_LABEL } from './retirementFacts';

// "จำหน่ายแล้ว": why a Retired Asset takes no new Loan, Repair Start or Reassignment, with a link to its Asset page,
// which shows its Retirement (F007-T2, F007-T3, #154 Q7, Q23). A refused correction adds that the Retirement is voided first, if it
// was recorded wrong, because no correction puts a Retired Asset back in use (#154 Q17).
export const RetiredReason: React.FC<{ assetId: string; refusedCorrection?: boolean }> = ({ assetId, refusedCorrection = false }) => (
  <>
    {RETIRED_LABEL}
    {refusedCorrection && ' ถ้าการจำหน่ายบันทึกผิด ต้องยกเลิกรายการจำหน่ายก่อน'}{' '}
    <Link to={`/assets/${assetId}`}>ดู{RETIREMENT_SECTION_LABEL}</Link>
  </>
);

// A write refused with 409 ASSET_RETIRED because its Asset was retired after the form opened: "<refused> เพราะ
// ครุภัณฑ์นี้จำหน่ายแล้ว" with the link to its Retirement (F007-T3, F007-T4, #154 Q7, Q12); null for another answer.
export const retiredRefusal = (body: any, refused: string = 'บันทึกไม่ได้'): React.ReactNode | null =>
  body?.code === 'ASSET_RETIRED' ? (
    <>
      {refused} เพราะครุภัณฑ์นี้<RetiredReason assetId={body.asset.asset_id} />
    </>
  ) : null;
