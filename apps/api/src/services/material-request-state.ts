// F009-T4 (#206): the one SQL source of the states of a Requested Item and a Material Request (#202 Q13, P10;
// CODING_STANDARDS, "A derived condition has one SQL source"). The lists, the page and T5's Cancels read it. A leaf of
// the Material Request module: it imports nothing.

// The states a Requested Item and a Material Request take in Feature 009: Pending (รอพิจารณา) until Cancelled
// (ยกเลิกแล้ว). Features 011 and 012 add their own.
export const MATERIAL_REQUEST_STATES = ['PENDING', 'CANCELLED'] as const;
export type MaterialRequestState = (typeof MATERIAL_REQUEST_STATES)[number];

/** SQL giving the state of the Requested Item joined as `item`: Pending until Cancelled. */
export const requestedItemState = (item: string): string => `(CASE WHEN ${item}.cancelled_at IS NULL THEN 'PENDING' ELSE 'CANCELLED' END)`;

/**
 * SQL giving the state of the Material Request joined as `request`, from its Requested Items: Cancelled when every one
 * is Cancelled, otherwise Pending.
 */
export const materialRequestState = (request: string): string =>
  `(CASE WHEN EXISTS (SELECT 1 FROM requested_items si WHERE si.material_request_id = ${request}.id AND ${requestedItemState('si')} = 'PENDING') THEN 'PENDING' ELSE 'CANCELLED' END)`;
