/**
 * F007-T6 (#160): the business dates of each non-voided assignment fact that `scope` keeps, for rows aliased `e`, as a
 * Retirement Conflict compares them (#154 P1): the Effective Date of a Reassignment or an Initial Assignment. An
 * Initial Assignment of unknown date has none. Each row names the Asset, the kind, the fact, its date and the fact
 * again as its record. This module imports nothing, so retirement-conflict.ts reads assignment facts through it.
 */
export const assignmentBusinessDates = (scope: string): string => `SELECT e.asset_id, CASE e.kind WHEN 'INITIAL' THEN 'INITIAL_ASSIGNMENT' ELSE 'REASSIGNMENT' END AS kind,
         e.id AS fact_id, e.effective_date AS fact_date, e.id AS record_id
       FROM assignment_events e
       WHERE NOT e.is_voided AND e.effective_date IS NOT NULL AND ${scope}`;
