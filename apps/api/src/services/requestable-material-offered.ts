// F009-T2 (#204): the one SQL source of whether a Requestable Material is offered to Requesters (#202 Q9, P10;
// CODING_STANDARDS, "A derived condition has one SQL source"). Its list, its page and the Supply Officer's badge read
// it; F009-T4's search of offered Requestable Materials and its Material Request create check it too. A leaf of the
// Requestable Material module: it imports nothing.

/**
 * SQL that holds when the Requestable Material joined as `requestable` is offered: it is active and has at least one
 * current Compatible Stock Material, whatever that Stock Material's own status (#202 Q9, Q16, MC-14).
 */
export const offered = (requestable: string): string =>
  `(${requestable}.is_active AND EXISTS (SELECT 1 FROM compatible_stock_materials oc WHERE oc.requestable_material_id = ${requestable}.id AND oc.is_current))`;
