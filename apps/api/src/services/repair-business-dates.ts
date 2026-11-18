/**
 * F007-T6 (#160): the business dates of each non-voided Repair Record that `scope` keeps, for rows aliased `r`, as a
 * Retirement Conflict compares them (#154 P1): its Start Date, by the record, and the Outcome Date of each non-voided
 * Repair Outcome, by the outcome. Each row names the Asset, the kind, the fact, its date and the Repair Record. This
 * module imports nothing, so retirement-conflict.ts reads Repair Records through it.
 */
export const repairRecordBusinessDates = (scope: string): string => `SELECT r.asset_id, 'REPAIR_START' AS kind, r.id AS fact_id, r.start_date AS fact_date, r.id AS record_id
       FROM repair_records r
       WHERE NOT r.is_voided AND ${scope}
       UNION ALL
       SELECT r.asset_id, 'REPAIR_OUTCOME', o.id, o.outcome_date, r.id
       FROM repair_outcomes o
       JOIN repair_records r ON r.id = o.repair_record_id
       WHERE NOT o.is_voided AND NOT r.is_voided AND ${scope}`;
