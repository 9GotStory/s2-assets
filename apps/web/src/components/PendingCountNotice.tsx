import React from 'react';
import { PENDING_LABEL, REQUESTED_ITEM_LABEL } from './materialRequestFacts';
import type { RequestableMaterialDetail } from './requestableMaterialFacts';

/**
 * F009-T7 (#209): how many Pending Requested Items ask for the Requestable Material, which stay Pending, shown before
 * a Supply Officer makes it Inactive or ends its last Compatible Stock Material (#202 Q16, P6).
 */
export const PendingCountNotice: React.FC<{ requestable: RequestableMaterialDetail; idPrefix: string }> = ({ requestable, idPrefix }) => (
  <p data-testid={`${idPrefix}-pending-count`} style={{ fontSize: '0.875rem', color: '#92400e', backgroundColor: '#fef3c7', borderRadius: '6px', padding: '0.5rem 0.75rem', margin: '0 0 1rem 0' }}>
    มี{REQUESTED_ITEM_LABEL} {requestable.pending_requested_item_count} รายการที่ยัง{PENDING_LABEL} ซึ่งจะยัง{PENDING_LABEL}ต่อไป
  </p>
);
