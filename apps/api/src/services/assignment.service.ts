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

export interface AssignmentChange {
  dimension: 'location' | 'organization_unit' | 'responsible_person';
  prior: AssignmentValue;
  new: AssignmentValue;
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
  changes: AssignmentChange[];
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
function normalizeText(value: unknown, field: string, maxLength: number, label: string): string | null {
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
const isCalendarDate = (value: string): boolean => {
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
 * An Initial Assignment's Effective Date as given: a calendar date no later than `today`, with no
 * lower bound, or null for unknown. Dates compare as text, which YYYY-MM-DD keeps in calendar order.
 */
function normalizeEffectiveDate(value: unknown, today: string, label: string): string | null {
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
async function assertAssignableEntries(
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

/**
 * Records a Reassignment and increments the Asset's assignment version, in the caller's transaction
 * and under its lock on the Asset. Each prior value is the one in effect at the Effective Date; a
 * dimension whose new value equals it is dropped, and a request left with no change is refused
 * (MR-01). Returns the event id.
 */
export async function recordReassignment(
  client: pg.PoolClient | pg.Pool,
  { assetId, actorId, facts, today }: { assetId: string; actorId: string; facts: ReassignmentFacts; today: string }
): Promise<string> {
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
    throw new ValidationError('This Reassignment changes nothing at its Effective Date');
  }
  await assertAssignableEntries(
    client,
    Object.fromEntries(changes.map(({ idField, target }) => [idField, target])),
    facts.effective_date < today
  );

  const eventRes = await client.query(
    `INSERT INTO assignment_events (asset_id, kind, effective_date, recorded_by, provenance, document_reference, remark)
     VALUES ($1, 'REASSIGNMENT', $2, $3, 'RECORDED', $4, $5)
     RETURNING id`,
    [assetId, facts.effective_date, actorId, facts.document_reference, facts.remark]
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

// An entry by its current name and active flag, or null when no entry is named.
const entrySummary = (id: string | null, name: string, isActive: boolean): ReferenceEntrySummary | null =>
  id ? { id, name, is_active: isActive } : null;

// The latest change of one dimension of the Asset whose id is the SQL expression `assetIdSql`, in
// the order of facts: Effective Date with unknown first, then Recorded At, then event id (MR-03).
// `eventCondition`, a SQL condition on the event `e`, narrows the facts considered.
const latestChange = (dimension: string, assetIdSql: string, select: string, eventCondition = 'true') => `SELECT ${select}
         FROM assignment_changes c
         JOIN assignment_events e ON e.id = c.event_id
         WHERE e.asset_id = ${assetIdSql} AND c.dimension = '${dimension}' AND ${eventCondition}
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
 *     WHERE e.asset_id = asset.id AND c.dimension = 'LOCATION'
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

/** An Asset's assignment facts in the order of facts, each with its changes in dimension order. */
export async function readAssignmentTimeline(
  client: pg.PoolClient | pg.Pool,
  assetId: string
): Promise<AssignmentEvent[]> {
  const eventsRes = await client.query(
    `SELECT e.id, e.kind, to_char(e.effective_date, 'YYYY-MM-DD') AS effective_date, e.recorded_at,
            e.recorded_by, u.username AS recorded_by_username, e.provenance, e.document_reference, e.remark
     FROM assignment_events e
     LEFT JOIN users u ON u.id = e.recorded_by
     WHERE e.asset_id = $1
     ORDER BY e.effective_date ASC NULLS FIRST, e.recorded_at ASC, e.id ASC`,
    [assetId]
  );
  // Each side's entry is in its dimension's own column and the others are null
  // (assignment_changes_own_list), so COALESCE picks it with its name and active flag.
  const entryOf = (side: 'prior' | 'new') => ({
    id: `COALESCE(${DIMENSIONS.map(({ column }) => `c.${side}_${column}`).join(', ')})`,
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
    changes: DIMENSIONS.flatMap(({ key, dimension }) =>
      changesRes.rows
        .filter((change: any) => change.event_id === row.id && change.dimension === dimension)
        .map((change: any) => ({
          dimension: key,
          prior: changeValueOf(change, 'prior'),
          new: changeValueOf(change, 'new'),
        }))
    ),
  }));
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
  // The Legacy text of the Asset's Initial Assignment, current or not (#50, the spec's search decision).
  legacyTextFilter: (field: LegacyTextField, param: string): string => {
    const { dimension } = DIMENSIONS.find(({ legacyField }) => legacyField === field)!;
    return `EXISTS (SELECT 1
         FROM assignment_changes c
         JOIN assignment_events e ON e.id = c.event_id
         WHERE e.asset_id = a.id AND e.kind = 'INITIAL' AND c.dimension = '${dimension}'
           AND c.new_legacy_text ILIKE ${param} ESCAPE '\\')`;
  },
  // The Current Assignment of each result row: select `columns` over `joins(alias)`, read with `current`.
  columns: ASSIGNMENT_COLUMNS,
  joins: assignmentJoins,
  current: permanentAssignmentOf,
};
