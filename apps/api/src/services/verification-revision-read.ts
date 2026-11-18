import pg from 'pg';

// A Verification Revision as another module cites it by id: a Repair Record's Repair Source (F006-T7, #132), and the
// result a Reassignment moves an Asset from (F006-T8, #133). This module reads no Repair or assignment table and
// imports no reads at run time, so those modules read it while verification-read.service.ts reads theirs, without
// an import cycle.

// The two Discrepancies a result's stored values derive, as SQL over the revision aliased `v` (#125 AV-07, Q7, Q26):
// verification-read.service.ts reads every result with them, and a citing write checks the one it needs.
// "Location ไม่ตรงทะเบียน" compares the Observed Location with the Location in effect on the Verification Date that the
// revision stored: an empty or Legacy-text one counts as different, and a left-out Observed Location as matching.
export const LOCATION_MISMATCH_CONDITION = (v: string) => `(${v}.observed_location_id IS NOT NULL AND ${v}.observed_location_id IS DISTINCT FROM ${v}.location_id)`;
export const DAMAGED_CONDITION = (v: string) => `(${v}.result = 'FOUND' AND ${v}.condition = 'DAMAGED')`;

/**
 * F007-T6 (#160): the business dates of each non-voided Found result that `scope` keeps, for rows aliased `entry`, as a
 * Retirement Conflict compares them (#154 P1): its Verification Date, by the revision. A Not Found result has none.
 * Each row names the Asset, the kind, the fact, its date and the Verification Round.
 */
export const foundRevisionBusinessDates = (scope: string): string => `SELECT entry.asset_id, 'FOUND' AS kind, v.id AS fact_id, v.verification_date AS fact_date,
         entry.verification_round_id AS record_id
       FROM verification_revisions v
       JOIN verification_scope_entries entry ON entry.id = v.verification_scope_entry_id
       WHERE v.result = 'FOUND' AND NOT v.is_voided AND ${scope}`;

export interface CitedVerificationRevision {
  verification_revision_id: string;
  verification_round: { id: string; name: string };
  verification_date: string;
  asset_id: string;
  // Found ชำรุด, as a Repair Source must be (#125 Q12).
  is_damaged: boolean;
  // "Location ไม่ตรงทะเบียน", as a result a Reassignment cites must have (#125 Q13).
  has_location_mismatch: boolean;
  // Voided by a Verification Correction (#125 Q18).
  is_voided: boolean;
}

// A cited revision as the citing record shows it: which result, of which Round and Verification Date, and whether a
// Verification Correction has voided it since (P1).
export type CitedVerificationRevisionView = Pick<CitedVerificationRevision, 'verification_revision_id' | 'verification_round' | 'verification_date' | 'is_voided'>;

export const citedRevisionViewOf = ({ verification_revision_id, verification_round, verification_date, is_voided }: CitedVerificationRevision): CitedVerificationRevisionView => ({
  verification_revision_id,
  verification_round,
  verification_date,
  is_voided,
});

const citedOf = (row: any): CitedVerificationRevision => ({
  verification_revision_id: row.id,
  verification_round: { id: row.verification_round_id, name: row.verification_round_name },
  verification_date: row.verification_date,
  asset_id: row.asset_id,
  is_damaged: row.is_damaged,
  has_location_mismatch: row.has_location_mismatch,
  is_voided: row.is_voided,
});

const CITED_REVISIONS = `SELECT v.id, r.id AS verification_round_id, r.name AS verification_round_name,
            to_char(v.verification_date, 'YYYY-MM-DD') AS verification_date, e.asset_id,
            ${DAMAGED_CONDITION('v')} AS is_damaged, ${LOCATION_MISMATCH_CONDITION('v')} AS has_location_mismatch, v.is_voided
     FROM verification_revisions v
     JOIN verification_scope_entries e ON e.id = v.verification_scope_entry_id
     JOIN verification_rounds r ON r.id = e.verification_round_id`;

/** Each of `revisionIds` that names a Verification Revision, voided or not. */
export async function verificationRevisionsOf(db: pg.Pool | pg.PoolClient | any, revisionIds: string[]): Promise<Map<string, CitedVerificationRevision>> {
  const res = await db.query(`${CITED_REVISIONS} WHERE v.id = ANY($1::uuid[])`, [revisionIds]);
  return new Map(res.rows.map((row: any): [string, CitedVerificationRevision] => [row.id, citedOf(row)]));
}

/**
 * A Verification Revision a write is about to cite, or null when there is none, read under a share lock of its
 * row. A Verification Correction's `UPDATE … SET is_voided = true` takes a lock that conflicts with it, so the
 * citing write and the void serialize and the later sees the earlier (CODING_STANDARDS, #132 decision
 * 6933747982). It locks neither the Round nor the scope entry: a result being recorded holds the entry while its
 * foreign key waits on a Repair Record a Repair Correction may hold.
 */
export async function lockCitedVerificationRevision(client: pg.PoolClient, revisionId: string): Promise<CitedVerificationRevision | null> {
  const res = await client.query(`${CITED_REVISIONS} WHERE v.id = $1 FOR SHARE OF v`, [revisionId]);
  return res.rows[0] ? citedOf(res.rows[0]) : null;
}
