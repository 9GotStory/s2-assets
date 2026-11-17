// F006-T7 (#132): SQL another module joins to ask whether a Repair Record cites a fact as its Repair Source. A leaf
// of the Repair modules (CODING_STANDARDS, "A feature's code gets its own files"): it imports nothing.

/**
 * SQL that holds when a Repair Record not voided cites, as its Repair Source, the Verification Revision whose id is
 * the SQL expression `revisionId`: "ส่งซ่อมแล้ว" (#125 Q19).
 */
export const citedByLiveRepairRecord = (revisionId: string): string =>
  `EXISTS (SELECT 1 FROM repair_records sr WHERE sr.repair_source_verification_revision_id = ${revisionId} AND NOT sr.is_voided)`;
