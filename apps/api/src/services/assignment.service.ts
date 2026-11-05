import pg from 'pg';
import { isValidUuid } from './capability.service.ts';
import { hasDisallowedControlChars } from './control-characters.ts';
import { findUnassignableEntry, REFERENCE_LISTS } from './reference.service.ts';
import { ValidationError } from './validation-error.ts';

/**
 * An Asset's Permanent Assignment (ADR 0001): its Location, OrganizationUnit and Responsible
 * Person. Each dimension names an entry of its Reference List, keeps Legacy text that matches no
 * entry, or is empty (AR-06, AR-10). Every read and write of the dimensions goes through here.
 */
export interface AssignmentInput {
  location_id?: string | null;
  organization_unit_id?: string | null;
  responsible_person_id?: string | null;
  legacy_location_text?: string | null;
  legacy_organization_unit_text?: string | null;
  legacy_responsible_person_text?: string | null;
}

export type AssignmentValues = { [K in keyof AssignmentInput]-?: string | null };

export type AssignmentField = keyof AssignmentInput;

export interface ReferenceEntrySummary {
  id: string;
  name: string;
  is_active: boolean;
}

// The Current Assignment: each dimension's entry by its current name, and its Legacy text.
export interface CurrentAssignment {
  location: ReferenceEntrySummary | null;
  organization_unit: ReferenceEntrySummary | null;
  responsible_person: ReferenceEntrySummary | null;
  legacy_location_text: string | null;
  legacy_organization_unit_text: string | null;
  legacy_responsible_person_text: string | null;
}

// The entry field of each dimension (location_id, organization_unit_id, responsible_person_id).
export const REFERENCE_ID_FIELDS = Object.values(REFERENCE_LISTS).map(({ assetColumn }) => assetColumn);

export const LEGACY_TEXT_FIELDS = [
  'legacy_location_text',
  'legacy_organization_unit_text',
  'legacy_responsible_person_text',
] as const;

export type LegacyTextField = (typeof LEGACY_TEXT_FIELDS)[number];

export const LEGACY_TEXT_MAX_LENGTH = 500;

export const ASSIGNMENT_FIELDS: readonly AssignmentField[] = [...REFERENCE_ID_FIELDS, ...LEGACY_TEXT_FIELDS];

/**
 * Validates and normalizes optional dimension values. Ids must be UUIDs; Legacy text is trimmed,
 * blank becomes null, and it is kept as recorded otherwise.
 */
export function normalizeAssignment(input: AssignmentInput, label: string = ''): AssignmentValues {
  const values = {} as AssignmentValues;
  for (const field of REFERENCE_ID_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) {
      values[field] = null;
    } else if (!isValidUuid(value)) {
      throw new ValidationError(`${field} must be a valid UUID${label}`);
    } else {
      values[field] = value.trim().toLowerCase();
    }
  }
  for (const field of LEGACY_TEXT_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) {
      values[field] = null;
      continue;
    }
    if (typeof value !== 'string') {
      throw new ValidationError(`${field} must be a string or null${label}`);
    }
    const text = value.trim();
    if (text.length > LEGACY_TEXT_MAX_LENGTH) {
      throw new ValidationError(`${field} must be at most ${LEGACY_TEXT_MAX_LENGTH} characters${label}`);
    }
    // Line breaks and tabs are allowed in Legacy text; other control characters are not.
    if (hasDisallowedControlChars(text)) {
      throw new ValidationError(`${field} must not contain control characters${label}`);
    }
    values[field] = text.length > 0 ? text : null;
  }
  return values;
}

export const hasAssignmentValues = (values: Partial<AssignmentValues>): boolean =>
  Object.values(values).some((value) => value !== null && value !== undefined);

/** Every named entry must be active now (D7); each is locked FOR SHARE (see findUnassignableEntry). */
export async function assertAssignableEntries(
  client: pg.PoolClient | pg.Pool,
  values: Partial<AssignmentValues>,
  label: string = ''
): Promise<void> {
  const field = await findUnassignableEntry(client, values);
  if (field) {
    throw new ValidationError(`${field} must name an active entry${label}`);
  }
}

// The values stored on an `assets` row.
export const assignmentValuesOf = (row: any): AssignmentValues => ({
  location_id: row.location_id ?? null,
  organization_unit_id: row.organization_unit_id ?? null,
  responsible_person_id: row.responsible_person_id ?? null,
  legacy_location_text: row.legacy_location_text ?? null,
  legacy_organization_unit_text: row.legacy_organization_unit_text ?? null,
  legacy_responsible_person_text: row.legacy_responsible_person_text ?? null,
});

const ASSIGNMENT_COLUMNS = `location_id, organization_unit_id, responsible_person_id,
       legacy_location_text, legacy_organization_unit_text, legacy_responsible_person_text`;

/** Stores the values given at registration on the just-inserted Asset. */
export async function recordInitialAssignment(
  client: pg.PoolClient | pg.Pool,
  assetId: string,
  values: AssignmentValues
): Promise<void> {
  if (!hasAssignmentValues(values)) {
    return;
  }
  await writeAssignmentValues(client, assetId, values);
}

/** The stored values of one Asset. */
export async function readAssignmentValues(
  client: pg.PoolClient | pg.Pool,
  assetId: string
): Promise<AssignmentValues> {
  const res = await client.query(`SELECT ${ASSIGNMENT_COLUMNS} FROM assets WHERE id = $1`, [assetId]);
  return assignmentValuesOf(res.rows[0] ?? {});
}

/** Replaces the stored values of one Asset (the Feature 002 registry correction). */
export async function writeAssignmentValues(
  client: pg.PoolClient | pg.Pool,
  assetId: string,
  values: AssignmentValues
): Promise<void> {
  await client.query(
    `UPDATE assets
     SET location_id = $2, organization_unit_id = $3, responsible_person_id = $4,
         legacy_location_text = $5, legacy_organization_unit_text = $6, legacy_responsible_person_text = $7
     WHERE id = $1`,
    [
      assetId,
      values.location_id,
      values.organization_unit_id,
      values.responsible_person_id,
      values.legacy_location_text,
      values.legacy_organization_unit_text,
      values.legacy_responsible_person_text,
    ]
  );
}

// The Current Assignment columns, with each entry's name, joined by currentJoins.
const CURRENT_COLUMNS = `cur.location_id, cur.organization_unit_id, cur.responsible_person_id,
       cur.legacy_location_text, cur.legacy_organization_unit_text, cur.legacy_responsible_person_text,
       l.name AS location_name, l.is_active AS location_active,
       o.name AS organization_unit_name, o.is_active AS organization_unit_active,
       p.name AS responsible_person_name, p.is_active AS responsible_person_active`;
// Joins the Current Assignment of the row aliased `alias`, whose `id` is the Asset's.
const currentJoins = (alias: string) => `LEFT JOIN assets cur ON cur.id = ${alias}.id
       LEFT JOIN locations l ON l.id = cur.location_id
       LEFT JOIN organization_units o ON o.id = cur.organization_unit_id
       LEFT JOIN persons p ON p.id = cur.responsible_person_id`;

// The Current Assignment from a row selected with currentColumns.
const currentAssignmentOf = (row: any): CurrentAssignment => {
  const entry = (prefix: string): ReferenceEntrySummary | null =>
    row[`${prefix}_id`] ? { id: row[`${prefix}_id`], name: row[`${prefix}_name`], is_active: row[`${prefix}_active`] } : null;
  return {
    location: entry('location'),
    organization_unit: entry('organization_unit'),
    responsible_person: entry('responsible_person'),
    legacy_location_text: row.legacy_location_text ?? null,
    legacy_organization_unit_text: row.legacy_organization_unit_text ?? null,
    legacy_responsible_person_text: row.legacy_responsible_person_text ?? null,
  };
};

/** The Current Assignment of one Asset and its stored values. */
export async function readCurrentAssignment(
  client: pg.PoolClient | pg.Pool,
  assetId: string
): Promise<{ values: AssignmentValues; current: CurrentAssignment }> {
  const res = await client.query(
    `SELECT ${CURRENT_COLUMNS} FROM (SELECT $1::uuid AS id) asset ${currentJoins('asset')}`,
    [assetId]
  );
  const row = res.rows[0] ?? {};
  return { values: assignmentValuesOf(row), current: currentAssignmentOf(row) };
}

/**
 * The asset search's use of the Permanent Assignment. Its conditions apply to the `assets` row
 * aliased `a`, each taking its value from the given parameter: an entry filter matches the Current
 * Assignment, and a legacy-text search matches that dimension's Legacy text alone.
 */
export const assignmentSearch = {
  entryFilter: (field: (typeof REFERENCE_ID_FIELDS)[number], param: string): string => `a.${field} = ${param}`,
  legacyTextFilter: (field: LegacyTextField, param: string): string => `a.${field} ILIKE ${param} ESCAPE '\\'`,
  // The Current Assignment of each result row: select `columns` over `joins(alias)`, read with `current`.
  columns: CURRENT_COLUMNS,
  joins: currentJoins,
  current: currentAssignmentOf,
};
