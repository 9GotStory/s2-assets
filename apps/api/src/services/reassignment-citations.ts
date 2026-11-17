// F006-T8 (#133): SQL another module joins to ask whether a Reassignment cites a Verification Revision. A leaf of the
// assignment modules (CODING_STANDARDS, "A feature's code gets its own files"): it imports nothing.

/**
 * SQL that holds when a Reassignment not voided cites the Verification Revision whose id is the SQL expression
 * `revisionId`: "ย้ายแล้ว" (#125 Q19).
 */
export const citedByLiveReassignment = (revisionId: string): string =>
  `EXISTS (SELECT 1 FROM assignment_events cr WHERE cr.verification_revision_id = ${revisionId} AND NOT cr.is_voided)`;
