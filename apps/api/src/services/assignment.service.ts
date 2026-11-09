import pg from 'pg';
import { isValidUuid } from './capability.service.ts';
import { hasDisallowedControlChars } from './control-characters.ts';
import { findUnassignableEntry } from './reference.service.ts';
import { ValidationError } from './validation-error.ts';

/**
 * An Asset's Permanent Assignment (ADR 0001): its Location, OrganizationUnit and Responsible
 * Person. Each dimension names an entry of its Reference List, keeps Legacy text that matches no
 * entry, or is empty (AR-06, AR-10). The values live in assignment facts: an event per business
 * action, with an Effective Date and a Recorded At, and a change per dimension it sets. Every read
 * and write of the dimensions goes through here.
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

// A Permanent Assignment as read from the facts: each dimension's entry by its current name, and its
// Legacy text. The shape is Feature 002's, which the asset search and detail already return.
export interface PermanentAssignment {
  location: ReferenceEntrySummary | null;
  organization_unit: ReferenceEntrySummary | null;
  responsible_person: ReferenceEntrySummary | null;
  legacy_location_text: string | null;
  legacy_organization_unit_text: string | null;
  legacy_responsible_person_text: string | null;
}

// The Permanent Assignment in effect today.
export type CurrentAssignment = PermanentAssignment;

// The facts an assignment action carries besides its dimension values (#50 Q5, Q11).
interface AssignmentFactInput {
  effective_date?: string | null;
  document_reference?: string | null;
  remark?: string | null;
}

// The Initial Assignment a registration records with its dimension values (#50 Q11, Q17).
export interface InitialAssignmentInput extends AssignmentInput, AssignmentFactInput {}

// A Reassignment's request. Legacy text can be named here only for the service to refuse it.
export interface ReassignmentInput extends AssignmentInput, AssignmentFactInput {}

export interface InitialAssignmentFacts {
  values: AssignmentValues;
  // null is "ไม่ทราบ" (unknown).
  effective_date: string | null;
  document_reference: string | null;
  remark: string | null;
}

export interface AssignmentValue {
  entry: ReferenceEntrySummary | null;
  legacy_text: string | null;
}

export type AssignmentDimension = 'location' | 'organization_unit' | 'responsible_person';

export interface AssignmentChange {
  dimension: AssignmentDimension;
  prior: AssignmentValue;
  new: AssignmentValue;
  // The value just before this change, when its stored prior value differs from it.
  conflict: { value_just_before: AssignmentValue } | null;
}

// A value as the store holds it. A correction record names an entry by id, so it reads by its current name (#50 Q20).
export interface StoredValue {
  entry_id: string | null;
  legacy_text: string | null;
}

export interface StoredChange {
  prior: StoredValue;
  new: StoredValue;
}

// The before and after of one field a correction changed. A dimension is null where the fact does not have it.
type CorrectionField<Change> =
  | { field: 'effective_date' | 'document_reference' | 'remark'; before: string | null; after: string | null }
  | { field: AssignmentDimension; before: Change | null; after: Change | null };

export type StoredCorrectionField = CorrectionField<StoredChange>;

export type AssignmentCorrectionField = CorrectionField<Pick<AssignmentChange, 'prior' | 'new'>>;

// One Assignment Correction of a fact (MR-06): who, when, why, and the before and after.
export interface AssignmentCorrection {
  id: string;
  action: 'AMENDED' | 'VOIDED';
  reason: string;
  recorded_at: string;
  recorded_by: string;
  recorded_by_username: string | null;
  changes: AssignmentCorrectionField[];
}

// One fact of an Asset's assignment timeline.
export interface AssignmentEvent {
  id: string;
  kind: 'INITIAL' | 'REASSIGNMENT';
  effective_date: string | null;
  recorded_at: string;
  recorded_by: string;
  recorded_by_username: string | null;
  provenance: 'RECORDED' | 'CARRIED_OVER_F002';
  document_reference: string | null;
  remark: string | null;
  is_voided: boolean;
  // What the events of one Bulk Reassignment share; null for any other fact.
  bulk_reference: string | null;
  changes: AssignmentChange[];
  corrections: AssignmentCorrection[];
}

// One Assignment Conflict (#50): a change whose stored prior value differs from the value just before
// it in the order of facts. Computed on read and never stored (ACQ-08).
export interface AssignmentConflict {
  asset_id: string;
  // null for a fact that a refused write would have recorded: it has no id until it is saved.
  event_id: string | null;
  kind: AssignmentEvent['kind'];
  effective_date: string | null;
  dimension: AssignmentDimension;
  recorded_prior: AssignmentValue;
  value_just_before: AssignmentValue;
}

// Each dimension's name in the API and in the database, its input fields, and its entry column in
// assignment_changes with the Reference List table that column names.
const DIMENSIONS = [
  {
    key: 'location',
    dimension: 'LOCATION',
    idField: 'location_id',
    legacyField: 'legacy_location_text',
    column: 'location_id',
    table: 'locations',
  },
  {
    key: 'organization_unit',
    dimension: 'ORGANIZATION_UNIT',
    idField: 'organization_unit_id',
    legacyField: 'legacy_organization_unit_text',
    column: 'organization_unit_id',
    table: 'organization_units',
  },
  {
    key: 'responsible_person',
    dimension: 'RESPONSIBLE_PERSON',
    idField: 'responsible_person_id',
    legacyField: 'legacy_responsible_person_text',
    column: 'person_id',
    table: 'persons',
  },
] as const;

// Each dimension's name in the API and its entry field, for code outside this module's tables.
export const DIMENSION_ID_FIELDS = DIMENSIONS.map(({ key, idField }) => ({ key, idField }));

// The entry field of each dimension (location_id, organization_unit_id, responsible_person_id).
export const REFERENCE_ID_FIELDS = DIMENSIONS.map(({ idField }) => idField);

export const LEGACY_TEXT_FIELDS = DIMENSIONS.map(({ legacyField }) => legacyField);

export type LegacyTextField = (typeof LEGACY_TEXT_FIELDS)[number];

export const ASSIGNMENT_FIELDS: readonly AssignmentField[] = [...REFERENCE_ID_FIELDS, ...LEGACY_TEXT_FIELDS];

export const LEGACY_TEXT_MAX_LENGTH = 500;
export const DOCUMENT_REFERENCE_MAX_LENGTH = 500;
export const REMARK_MAX_LENGTH = 2000;

// Optional text kept as given (Legacy text, document reference, remark): trimmed, blank as none,
// bounded, and free of control characters other than line breaks and tabs, as in Feature 002.
export function normalizeText(value: unknown, field: string, maxLength: number, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string or null${label}`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new ValidationError(`${field} must be at most ${maxLength} characters${label}`);
  }
  if (hasDisallowedControlChars(text)) {
    throw new ValidationError(`${field} must not contain control characters${label}`);
  }
  return text.length > 0 ? text : null;
}

/** Validates and normalizes optional dimension values: ids must be UUIDs; Legacy text is kept as recorded. */
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
    values[field] = normalizeText(input[field], field, LEGACY_TEXT_MAX_LENGTH, label);
  }
  return values;
}

export const hasAssignmentValues = (values: Partial<AssignmentValues>): boolean =>
  Object.values(values).some((value) => value !== null && value !== undefined);

// Whether a request names any dimension value, before validation: what an authorization check sees.
export const namesAssignmentValues = (input: AssignmentInput): boolean =>
  ASSIGNMENT_FIELDS.some((field) => input[field] !== undefined && input[field] !== null);

// The facts an Initial Assignment carries besides its dimension values.
const INITIAL_ASSIGNMENT_FACT_FIELDS = ['effective_date', 'document_reference', 'remark'] as const;

const BANGKOK_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Bangkok',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Asia/Bangkok calendar date of an instant, as YYYY-MM-DD: "today" for an Effective Date (#50 Q2). */
export function bangkokDate(instant: Date): string {
  const parts = Object.fromEntries(BANGKOK_DATE.formatToParts(instant).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// A YYYY-MM-DD date of the Gregorian calendar from year 1, which PostgreSQL stores as given.
export const isCalendarDate = (value: string): boolean => {
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const [year, month, day] = match.slice(1).map(Number);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return year >= 1 && daysInMonth !== undefined && day >= 1 && day <= daysInMonth;
};

/**
 * An assignment fact's Effective Date as given: a calendar date no later than `today`, with no
 * lower bound, or null for unknown. Dates compare as text, which YYYY-MM-DD keeps in calendar order.
 */
export function normalizeEffectiveDate(value: unknown, today: string, label: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !isCalendarDate(value)) {
    throw new ValidationError(`effective_date must be a date (YYYY-MM-DD) or null for unknown${label}`);
  }
  if (value > today) {
    throw new ValidationError(`effective_date must not be after today (${today}, Asia/Bangkok)${label}`);
  }
  return value;
}

/**
 * The Initial Assignment a registration records, or null when it names no dimension value. Its
 * Effective Date must then be given: a date no later than `today`, or null for unknown (#50 Q11).
 */
export function normalizeInitialAssignment(
  input: InitialAssignmentInput,
  today: string,
  label: string = ''
): InitialAssignmentFacts | null {
  const values = normalizeAssignment(input, label);
  if (!hasAssignmentValues(values)) {
    const stray = INITIAL_ASSIGNMENT_FACT_FIELDS.filter((field) => input[field] !== undefined);
    if (stray.length > 0) {
      throw new ValidationError(
        `${stray.join(', ')} belongs to an Initial Assignment and needs a Location, OrganizationUnit or Responsible Person value${label}`
      );
    }
    return null;
  }
  if (input.effective_date === undefined) {
    throw new ValidationError(
      `effective_date is required with a Location, OrganizationUnit or Responsible Person value: a date (YYYY-MM-DD) or null for unknown${label}`
    );
  }
  return {
    values,
    effective_date: normalizeEffectiveDate(input.effective_date, today, label),
    document_reference: normalizeText(input.document_reference, 'document_reference', DOCUMENT_REFERENCE_MAX_LENGTH, label),
    remark: normalizeText(input.remark, 'remark', REMARK_MAX_LENGTH, label),
  };
}

// Each entry must be in its own dimension's list and, unless `allowInactive`, active. Each is locked
// FOR SHARE (see findUnassignableEntry).
export async function assertAssignableEntries(
  client: pg.PoolClient | pg.Pool,
  ids: Parameters<typeof findUnassignableEntry>[1],
  allowInactive: boolean,
  label: string = ''
): Promise<void> {
  const field = await findUnassignableEntry(client, ids, { allowInactive });
  if (field) {
    throw new ValidationError(
      allowInactive ? `${field} must name an entry of its list${label}` : `${field} must name an active entry${label}`
    );
  }
}

/**
 * An Initial Assignment's entries must each be in their own dimension's list. A deactivated entry
 * may be named only for an Effective Date before today or unknown, so that old history can name
 * closed rooms and departed staff (#50 Q16).
 */
export async function assertInitialAssignmentEntries(
  client: pg.PoolClient | pg.Pool,
  facts: InitialAssignmentFacts,
  today: string,
  label: string = ''
): Promise<void> {
  await assertAssignableEntries(client, facts.values, facts.effective_date === null || facts.effective_date < today, label);
}

/**
 * Records an Asset's Initial Assignment, one change per dimension it sets, and increments the
 * Asset's assignment version, all in the caller's transaction. Returns the event id.
 */
export async function recordInitialAssignment(
  client: pg.PoolClient | pg.Pool,
  { assetId, actorId, facts }: { assetId: string; actorId: string; facts: InitialAssignmentFacts }
): Promise<string> {
  const eventRes = await client.query(
    `INSERT INTO assignment_events (asset_id, kind, effective_date, recorded_by, provenance, document_reference, remark)
     VALUES ($1, 'INITIAL', $2, $3, 'RECORDED', $4, $5)
     RETURNING id`,
    [assetId, facts.effective_date, actorId, facts.document_reference, facts.remark]
  );
  const eventId: string = eventRes.rows[0].id;
  for (const { dimension, idField, legacyField, column } of DIMENSIONS) {
    const entryId = facts.values[idField];
    const legacyText = facts.values[legacyField];
    if (entryId === null && legacyText === null) {
      continue;
    }
    await client.query(
      `INSERT INTO assignment_changes (event_id, event_kind, dimension, new_${column}, new_legacy_text)
       VALUES ($1, 'INITIAL', $2, $3, $4)`,
      [eventId, dimension, entryId, legacyText]
    );
  }
  await client.query('UPDATE assets SET assignment_version = assignment_version + 1 WHERE id = $1', [assetId]);
  return eventId;
}

// What a Reassignment asks for. A dimension left out of `targets` stays as it is; null clears it.
export interface ReassignmentFacts {
  targets: Partial<Record<(typeof REFERENCE_ID_FIELDS)[number], string | null>>;
  effective_date: string;
  document_reference: string | null;
  remark: string | null;
}

/**
 * A Reassignment's request. Each new value names an entry or, for the OrganizationUnit and the
 * Responsible Person only, clears the dimension (#50 Q15); Legacy text is never a new value (Q14).
 * Its Effective Date is a real date no later than `today`: unknown belongs to an Initial Assignment (Q11).
 */
export function normalizeReassignment(input: ReassignmentInput, today: string): ReassignmentFacts {
  const legacy = LEGACY_TEXT_FIELDS.filter((field) => input[field] !== undefined);
  if (legacy.length > 0) {
    throw new ValidationError(`A Reassignment names Reference List entries, never Legacy text (${legacy.join(', ')})`);
  }
  if (input.location_id === null) {
    throw new ValidationError('A Reassignment cannot clear the Location: name another entry');
  }
  if (input.effective_date === undefined || input.effective_date === null) {
    throw new ValidationError('effective_date is required on a Reassignment: a date (YYYY-MM-DD), never unknown');
  }
  const values = normalizeAssignment(input);
  return {
    targets: Object.fromEntries(
      REFERENCE_ID_FIELDS.filter((field) => input[field] !== undefined).map((field) => [field, values[field]])
    ),
    effective_date: normalizeEffectiveDate(input.effective_date, today, '') as string,
    document_reference: normalizeText(input.document_reference, 'document_reference', DOCUMENT_REFERENCE_MAX_LENGTH, ''),
    remark: normalizeText(input.remark, 'remark', REMARK_MAX_LENGTH, ''),
  };
}

export interface ReassignmentWrite {
  assetId: string;
  actorId: string;
  facts: ReassignmentFacts;
  today: string;
}

/**
 * Records a Reassignment and increments the Asset's assignment version, in the caller's transaction
 * and under its lock on the Asset. Each prior value is the one in effect at the Effective Date, and a
 * dimension whose new value equals it is dropped. Returns the event id, or null with nothing written
 * when no dimension is left (MR-01).
 */
export async function recordReassignmentIfItChanges(
  client: pg.PoolClient | pg.Pool,
  { assetId, actorId, facts, today, bulkReference }: ReassignmentWrite & { bulkReference?: string }
): Promise<string | null> {
  const prior = await readAssignmentAt(client, assetId, facts.effective_date);
  const changes = DIMENSIONS.flatMap(({ key, dimension, idField, legacyField, column }) => {
    const target = facts.targets[idField];
    const priorEntry = prior[key]?.id ?? null;
    const priorLegacy = prior[legacyField];
    return target === undefined || (target === priorEntry && priorLegacy === null)
      ? []
      : [{ dimension, idField, column, target, priorEntry, priorLegacy }];
  });
  if (changes.length === 0) {
    return null;
  }
  await assertAssignableEntries(
    client,
    Object.fromEntries(changes.map(({ idField, target }) => [idField, target])),
    facts.effective_date < today
  );

  const eventRes = await client.query(
    `INSERT INTO assignment_events (asset_id, kind, effective_date, recorded_by, provenance, document_reference, remark, bulk_reference)
     VALUES ($1, 'REASSIGNMENT', $2, $3, 'RECORDED', $4, $5, $6)
     RETURNING id`,
    [assetId, facts.effective_date, actorId, facts.document_reference, facts.remark, bulkReference ?? null]
  );
  const eventId: string = eventRes.rows[0].id;
  for (const { dimension, column, target, priorEntry, priorLegacy } of changes) {
    await client.query(
      `INSERT INTO assignment_changes (event_id, event_kind, dimension, prior_${column}, prior_legacy_text, new_${column})
       VALUES ($1, 'REASSIGNMENT', $2, $3, $4, $5)`,
      [eventId, dimension, priorEntry, priorLegacy, target]
    );
  }
  await client.query('UPDATE assets SET assignment_version = assignment_version + 1 WHERE id = $1', [assetId]);
  return eventId;
}

/** Records a Reassignment as above, refusing one that changes nothing (MR-01). Returns the event id. */
export async function recordReassignment(client: pg.PoolClient | pg.Pool, input: ReassignmentWrite): Promise<string> {
  const eventId = await recordReassignmentIfItChanges(client, input);
  if (eventId === null) {
    throw new ValidationError('This Reassignment changes nothing at its Effective Date');
  }
  return eventId;
}

// An Asset under a batch's lock.
export interface LockedAsset {
  id: string;
  name: string | null;
  asset_number: string | null;
  assignment_version: number;
}

/**
 * Locks the Assets that exist among `assetIds`, in identifier order so that batches over the same
 * Assets cannot deadlock (#50). PostgreSQL sorts before it locks; an id never changes, so the order holds.
 */
export async function lockAssetsInIdentifierOrder(client: pg.PoolClient, assetIds: string[]): Promise<LockedAsset[]> {
  const res = await client.query(
    'SELECT id, name, asset_number, assignment_version FROM assets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [assetIds]
  );
  return res.rows;
}

/** The Assets among `assetIds` that have a non-voided Initial Assignment. */
export async function assetsWithInitialAssignment(client: pg.PoolClient, assetIds: string[]): Promise<Set<string>> {
  const res = await client.query(
    `SELECT asset_id FROM assignment_events WHERE asset_id = ANY($1::uuid[]) AND kind = 'INITIAL' AND NOT is_voided`,
    [assetIds]
  );
  return new Set(res.rows.map((row: any) => row.asset_id));
}

// An entry by its current name and active flag, or null when no entry is named.
const entrySummary = (id: string | null, name: string, isActive: boolean): ReferenceEntrySummary | null =>
  id ? { id, name, is_active: isActive } : null;

// The latest change of one dimension of the Asset whose id is the SQL expression `assetIdSql`, in
// the order of facts: Effective Date with unknown first, then Recorded At, then event id (MR-03).
// A voided fact takes no part. `eventCondition`, a SQL condition on the event `e`, narrows the facts considered.
const latestChange = (dimension: string, assetIdSql: string, select: string, eventCondition = 'true') => `SELECT ${select}
         FROM assignment_changes c
         JOIN assignment_events e ON e.id = c.event_id
         WHERE e.asset_id = ${assetIdSql} AND c.dimension = '${dimension}' AND NOT e.is_voided AND ${eventCondition}
         ORDER BY e.effective_date DESC NULLS LAST, e.recorded_at DESC, e.id DESC
         LIMIT 1`;

// The columns of a Permanent Assignment, with each entry's name, joined by assignmentJoins.
const ASSIGNMENT_COLUMNS = DIMENSIONS.map(
  ({ key, idField, legacyField }) => `dim_${key}.entry_id AS ${idField}, dim_${key}_entry.name AS ${key}_name,
       dim_${key}_entry.is_active AS ${key}_active, dim_${key}.legacy_text AS ${legacyField}`
).join(',\n       ');

/**
 * Joins the Permanent Assignment of the row aliased `alias`, whose `id` is the Asset's: its Current
 * Assignment, unless `eventCondition` narrows the facts. For the Location of `asset` it writes, and
 * likewise for the other two dimensions:
 *
 *   LEFT JOIN LATERAL (
 *     SELECT c.new_location_id AS entry_id, c.new_legacy_text AS legacy_text
 *     FROM assignment_changes c JOIN assignment_events e ON e.id = c.event_id
 *     WHERE e.asset_id = asset.id AND c.dimension = 'LOCATION' AND NOT e.is_voided
 *     ORDER BY e.effective_date DESC NULLS LAST, e.recorded_at DESC, e.id DESC
 *     LIMIT 1
 *   ) dim_location ON true
 *   LEFT JOIN locations dim_location_entry ON dim_location_entry.id = dim_location.entry_id
 */
const assignmentJoins = (alias: string, eventCondition?: string) =>
  DIMENSIONS.map(
    ({ key, dimension, column, table }) => `LEFT JOIN LATERAL (
         ${latestChange(dimension, `${alias}.id`, `c.new_${column} AS entry_id, c.new_legacy_text AS legacy_text`, eventCondition)}
       ) dim_${key} ON true
       LEFT JOIN ${table} dim_${key}_entry ON dim_${key}_entry.id = dim_${key}.entry_id`
  ).join('\n       ');

// The Permanent Assignment from a row selected with ASSIGNMENT_COLUMNS.
const permanentAssignmentOf = (row: any): PermanentAssignment =>
  Object.fromEntries(
    DIMENSIONS.flatMap(({ key, idField, legacyField }) => [
      [key, entrySummary(row[idField] ?? null, row[`${key}_name`], row[`${key}_active`])],
      [legacyField, row[legacyField] ?? null],
    ])
  ) as unknown as PermanentAssignment;

/** The Current Assignment of one Asset, derived from its facts, and its assignment version. */
export async function readCurrentAssignment(
  client: pg.PoolClient | pg.Pool,
  assetId: string
): Promise<{ current: CurrentAssignment; version: number }> {
  const res = await client.query(
    `SELECT a.assignment_version, ${ASSIGNMENT_COLUMNS} FROM assets a ${assignmentJoins('a')} WHERE a.id = $1`,
    [assetId]
  );
  const row = res.rows[0] ?? {};
  return { current: permanentAssignmentOf(row), version: row.assignment_version ?? 0 };
}

/**
 * The Permanent Assignment in effect on an Effective Date: each dimension's latest fact at or before
 * it, facts of unknown date included (they come first). A fact recorded now follows every fact on
 * its own date, so these are its prior values.
 */
async function readAssignmentAt(
  client: pg.PoolClient | pg.Pool,
  assetId: string,
  effectiveDate: string
): Promise<PermanentAssignment> {
  const res = await client.query(
    `SELECT ${ASSIGNMENT_COLUMNS}
     FROM assets a ${assignmentJoins('a', '(e.effective_date IS NULL OR e.effective_date <= $2::date)')}
     WHERE a.id = $1`,
    [assetId, effectiveDate]
  );
  return permanentAssignmentOf(res.rows[0]);
}

// One side of a change row selected by readAssignmentTimeline.
const changeValueOf = (row: any, side: 'prior' | 'new'): AssignmentValue => ({
  entry: entrySummary(row[`${side}_entry_id`] ?? null, row[`${side}_entry_name`], row[`${side}_entry_active`]),
  legacy_text: row[`${side}_legacy_text`] ?? null,
});

export const isDimensionField = (stored: StoredCorrectionField): stored is Extract<StoredCorrectionField, { field: AssignmentDimension }> =>
  DIMENSIONS.some(({ key }) => key === stored.field);

// The entries named by id, with their current names and active flags.
async function readEntries(
  client: pg.PoolClient | pg.Pool,
  entryIds: (string | null)[]
): Promise<Map<string, ReferenceEntrySummary>> {
  const ids = new Set(entryIds.filter((id) => id !== null));
  if (ids.size === 0) {
    return new Map();
  }
  const res = await client.query(
    DIMENSIONS.map(({ table }) => `SELECT id, name, is_active FROM ${table} WHERE id = ANY($1::uuid[])`).join(' UNION ALL '),
    [[...ids]]
  );
  return new Map(res.rows.map((row: any) => [row.id, { id: row.id, name: row.name, is_active: row.is_active }]));
}

// The entries that correction records name.
const readCorrectionEntries = (
  client: pg.PoolClient | pg.Pool,
  fields: StoredCorrectionField[]
): Promise<Map<string, ReferenceEntrySummary>> =>
  readEntries(
    client,
    fields
      .filter(isDimensionField)
      .flatMap(({ before, after }) => [before, after])
      .flatMap((change) => (change ? [change.prior.entry_id, change.new.entry_id] : []))
  );

// The entry of one side of a change: it is in its dimension's own column and the others are null
// (assignment_changes_own_list).
const changeEntryId = (side: 'prior' | 'new') => `COALESCE(${DIMENSIONS.map(({ column }) => `c.${side}_${column}`).join(', ')})`;

// The Assignment Conflicts of the Asset whose id is the SQL expression `assetIdSql`: each change whose
// stored prior value, entry and Legacy text, differs from the new value of the preceding change of its
// dimension in the order of facts, or from empty when none precedes it. A voided fact takes no part (#50).
const conflictingChanges = (assetIdSql: string) => `SELECT *
         FROM (
           SELECT e.asset_id, e.id AS event_id, e.kind, e.effective_date, e.recorded_at, c.dimension,
                  ${changeEntryId('prior')} AS prior_entry_id, c.prior_legacy_text,
                  LAG(${changeEntryId('new')}) OVER facts AS before_entry_id,
                  LAG(c.new_legacy_text) OVER facts AS before_legacy_text
           FROM assignment_changes c
           JOIN assignment_events e ON e.id = c.event_id
           WHERE e.asset_id = ${assetIdSql} AND NOT e.is_voided
           WINDOW facts AS (PARTITION BY c.dimension ORDER BY e.effective_date ASC NULLS FIRST, e.recorded_at ASC, e.id ASC)
         ) ordered
         WHERE prior_entry_id IS DISTINCT FROM before_entry_id OR prior_legacy_text IS DISTINCT FROM before_legacy_text`;

/** An Asset's Assignment Conflicts in the order of facts, each fact's in dimension order. */
export async function readAssignmentConflicts(
  client: pg.PoolClient | pg.Pool,
  assetId: string
): Promise<AssignmentConflict[]> {
  const res = await client.query(
    `SELECT conflicts.asset_id, conflicts.event_id, conflicts.kind, to_char(conflicts.effective_date, 'YYYY-MM-DD') AS effective_date,
            conflicts.dimension, conflicts.prior_entry_id, conflicts.prior_legacy_text, conflicts.before_entry_id, conflicts.before_legacy_text
     FROM (${conflictingChanges('$1::uuid')}) conflicts
     ORDER BY conflicts.effective_date ASC NULLS FIRST, conflicts.recorded_at ASC, conflicts.event_id ASC, conflicts.dimension ASC`,
    [assetId]
  );
  const entries = await readEntries(
    client,
    res.rows.flatMap((row: any) => [row.prior_entry_id, row.before_entry_id])
  );
  const entryOf = (id: string | null): ReferenceEntrySummary | null => (id ? (entries.get(id) ?? null) : null);
  return res.rows.map((row: any) => ({
    asset_id: row.asset_id,
    event_id: row.event_id,
    kind: row.kind,
    effective_date: row.effective_date ?? null,
    dimension: DIMENSIONS.find(({ dimension }) => dimension === row.dimension)!.key,
    recorded_prior: { entry: entryOf(row.prior_entry_id), legacy_text: row.prior_legacy_text ?? null },
    value_just_before: { entry: entryOf(row.before_entry_id), legacy_text: row.before_legacy_text ?? null },
  }));
}

const correctionFieldOf = (stored: StoredCorrectionField, entries: Map<string, ReferenceEntrySummary>): AssignmentCorrectionField => {
  if (!isDimensionField(stored)) {
    return stored;
  }
  const valueOf = ({ entry_id, legacy_text }: StoredValue): AssignmentValue => ({
    entry: entry_id ? (entries.get(entry_id) ?? null) : null,
    legacy_text,
  });
  const changeOf = (change: StoredChange | null) => change && { prior: valueOf(change.prior), new: valueOf(change.new) };
  return { field: stored.field, before: changeOf(stored.before), after: changeOf(stored.after) };
};

/** Whether an Asset has any Assignment Conflict. */
export async function hasAssignmentConflict(client: pg.PoolClient | pg.Pool, assetId: string): Promise<boolean> {
  const res = await client.query(`SELECT EXISTS (${conflictingChanges('$1::uuid')}) AS has_conflict`, [assetId]);
  return res.rows[0].has_conflict;
}

/** An Asset's assignment facts in the order of facts, each with its changes in dimension order and its corrections in the order made. */
export async function readAssignmentTimeline(
  client: pg.PoolClient | pg.Pool,
  assetId: string
): Promise<AssignmentEvent[]> {
  const eventsRes = await client.query(
    `SELECT e.id, e.kind, to_char(e.effective_date, 'YYYY-MM-DD') AS effective_date, e.recorded_at,
            e.recorded_by, u.username AS recorded_by_username, e.provenance, e.document_reference, e.remark, e.is_voided,
            e.bulk_reference
     FROM assignment_events e
     LEFT JOIN users u ON u.id = e.recorded_by
     WHERE e.asset_id = $1
     ORDER BY e.effective_date ASC NULLS FIRST, e.recorded_at ASC, e.id ASC`,
    [assetId]
  );
  // Each side's entry is in its dimension's own column and the others are null
  // (assignment_changes_own_list), so COALESCE picks it with its name and active flag.
  const entryOf = (side: 'prior' | 'new') => ({
    id: changeEntryId(side),
    name: `COALESCE(${DIMENSIONS.map(({ key }) => `${side}_${key}.name`).join(', ')})`,
    active: `COALESCE(${DIMENSIONS.map(({ key }) => `${side}_${key}.is_active`).join(', ')})`,
    joins: DIMENSIONS.map(
      ({ key, column, table }) => `LEFT JOIN ${table} ${side}_${key} ON ${side}_${key}.id = c.${side}_${column}`
    ).join('\n     '),
  });
  const priorSide = entryOf('prior');
  const newSide = entryOf('new');
  const changesRes = await client.query(
    `SELECT c.event_id, c.dimension,
            ${priorSide.id} AS prior_entry_id, ${priorSide.name} AS prior_entry_name,
            ${priorSide.active} AS prior_entry_active, c.prior_legacy_text,
            ${newSide.id} AS new_entry_id, ${newSide.name} AS new_entry_name,
            ${newSide.active} AS new_entry_active, c.new_legacy_text
     FROM assignment_changes c
     JOIN assignment_events e ON e.id = c.event_id
     ${priorSide.joins}
     ${newSide.joins}
     WHERE e.asset_id = $1`,
    [assetId]
  );
  const correctionsRes = await client.query(
    `SELECT r.id, r.event_id, r.action, r.reason, r.changes, r.recorded_at, r.recorded_by, u.username AS recorded_by_username
     FROM assignment_corrections r
     JOIN assignment_events e ON e.id = r.event_id
     LEFT JOIN users u ON u.id = r.recorded_by
     WHERE e.asset_id = $1
     ORDER BY r.recorded_at ASC, r.id ASC`,
    [assetId]
  );
  const correctionEntries = await readCorrectionEntries(
    client,
    correctionsRes.rows.flatMap((correction: any) => correction.changes)
  );
  const conflicts = await readAssignmentConflicts(client, assetId);
  const conflictOf = (eventId: string, key: AssignmentDimension): AssignmentChange['conflict'] => {
    const conflict = conflicts.find(({ event_id, dimension }) => event_id === eventId && dimension === key);
    return conflict ? { value_just_before: conflict.value_just_before } : null;
  };
  return eventsRes.rows.map((row: any) => ({
    id: row.id,
    kind: row.kind,
    effective_date: row.effective_date ?? null,
    recorded_at: new Date(row.recorded_at).toISOString(),
    recorded_by: row.recorded_by,
    recorded_by_username: row.recorded_by_username ?? null,
    provenance: row.provenance,
    document_reference: row.document_reference ?? null,
    remark: row.remark ?? null,
    is_voided: row.is_voided,
    bulk_reference: row.bulk_reference ?? null,
    changes: DIMENSIONS.flatMap(({ key, dimension }) =>
      changesRes.rows
        .filter((change: any) => change.event_id === row.id && change.dimension === dimension)
        .map((change: any) => ({
          dimension: key,
          prior: changeValueOf(change, 'prior'),
          new: changeValueOf(change, 'new'),
          conflict: conflictOf(row.id, key),
        }))
    ),
    corrections: correctionsRes.rows
      .filter((correction: any) => correction.event_id === row.id)
      .map((correction: any) => ({
        id: correction.id,
        action: correction.action,
        reason: correction.reason,
        recorded_at: new Date(correction.recorded_at).toISOString(),
        recorded_by: correction.recorded_by,
        recorded_by_username: correction.recorded_by_username ?? null,
        changes: correction.changes.map((field: StoredCorrectionField) => correctionFieldOf(field, correctionEntries)),
      })),
  }));
}

// An assignment fact as it stands, under the Asset's lock, for a correction to compare against.
export interface StoredAssignmentEvent {
  kind: 'INITIAL' | 'REASSIGNMENT';
  effective_date: string | null;
  document_reference: string | null;
  remark: string | null;
  is_voided: boolean;
  changes: Partial<Record<AssignmentDimension, StoredChange>>;
}

/** One fact of an Asset as it stands, or null when the Asset has no such fact. */
export async function readStoredEvent(
  client: pg.PoolClient,
  assetId: string,
  eventId: string
): Promise<StoredAssignmentEvent | null> {
  const eventRes = await client.query(
    `SELECT kind, to_char(effective_date, 'YYYY-MM-DD') AS effective_date, document_reference, remark, is_voided
     FROM assignment_events WHERE id = $1 AND asset_id = $2`,
    [eventId, assetId]
  );
  if (eventRes.rows.length === 0) {
    return null;
  }
  const changesRes = await client.query('SELECT * FROM assignment_changes WHERE event_id = $1', [eventId]);
  const changes: StoredAssignmentEvent['changes'] = {};
  for (const { key, dimension, column } of DIMENSIONS) {
    const row = changesRes.rows.find((change: any) => change.dimension === dimension);
    if (row) {
      changes[key] = {
        prior: { entry_id: row[`prior_${column}`], legacy_text: row.prior_legacy_text },
        new: { entry_id: row[`new_${column}`], legacy_text: row.new_legacy_text },
      };
    }
  }
  return { ...eventRes.rows[0], changes };
}

/** Leaves one dimension of a fact as a correction decided: changed, added, or, when `after` is null, removed. */
export async function writeCorrectedChange(
  client: pg.PoolClient,
  eventId: string,
  kind: StoredAssignmentEvent['kind'],
  key: AssignmentDimension,
  after: StoredChange | null
): Promise<void> {
  const { dimension, column } = DIMENSIONS.find((candidate) => candidate.key === key)!;
  if (!after) {
    await client.query('DELETE FROM assignment_changes WHERE event_id = $1 AND dimension = $2', [eventId, dimension]);
    return;
  }
  await client.query(
    `INSERT INTO assignment_changes
       (event_id, event_kind, dimension, prior_${column}, prior_legacy_text, new_${column}, new_legacy_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (event_id, dimension) DO UPDATE SET
       prior_${column} = EXCLUDED.prior_${column},
       prior_legacy_text = EXCLUDED.prior_legacy_text,
       new_${column} = EXCLUDED.new_${column},
       new_legacy_text = EXCLUDED.new_legacy_text`,
    [eventId, kind, dimension, after.prior.entry_id, after.prior.legacy_text, after.new.entry_id, after.new.legacy_text]
  );
}

/**
 * The asset search's use of the Permanent Assignment. Its conditions apply to the `assets` row
 * aliased `a`, each taking its value from the given parameter: an entry filter matches the Current
 * Assignment, and a legacy-text search matches that dimension's Legacy text alone.
 */
export const assignmentSearch = {
  entryFilter: (field: (typeof REFERENCE_ID_FIELDS)[number], param: string): string => {
    const { dimension, column } = DIMENSIONS.find(({ idField }) => idField === field)!;
    return `(${latestChange(dimension, 'a.id', `c.new_${column}`)}) = ${param}`;
  },
  // The Legacy text of the Asset's non-voided Initial Assignment, current or not (#50, the spec's search decision).
  legacyTextFilter: (field: LegacyTextField, param: string): string => {
    const { dimension } = DIMENSIONS.find(({ legacyField }) => legacyField === field)!;
    return `EXISTS (SELECT 1
         FROM assignment_changes c
         JOIN assignment_events e ON e.id = c.event_id
         WHERE e.asset_id = a.id AND e.kind = 'INITIAL' AND NOT e.is_voided AND c.dimension = '${dimension}'
           AND c.new_legacy_text ILIKE ${param} ESCAPE '\\')`;
  },
  // The Asset has at least one Assignment Conflict.
  conflictFilter: `EXISTS (${conflictingChanges('a.id')})`,
  // The Current Assignment of each result row: select `columns` over `joins(alias)`, read with `current`.
  columns: ASSIGNMENT_COLUMNS,
  joins: assignmentJoins,
  current: permanentAssignmentOf,
};
