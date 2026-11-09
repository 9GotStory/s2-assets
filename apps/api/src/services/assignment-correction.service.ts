import pg from 'pg';
import { NotFoundError } from './asset.service.ts';
import {
  DIMENSIONS,
  DOCUMENT_REFERENCE_MAX_LENGTH,
  LEGACY_TEXT_MAX_LENGTH,
  REMARK_MAX_LENGTH,
  assertAssignableEntries,
  bangkokDate,
  isDimensionField,
  normalizeEffectiveDate,
  normalizeText,
  type AssignmentDimension,
  type CorrectedChange,
  type CorrectedValue,
  type StoredCorrectionField,
} from './assignment.service.ts';
import { writeAssignmentOnce, type RecordedAssignment } from './assignment-write.ts';
import { isValidUuid } from './capability.service.ts';
import { ValidationError } from './validation-error.ts';

const REASON_MAX_LENGTH = REMARK_MAX_LENGTH;

const NO_VALUE: CorrectedValue = { entry_id: null, legacy_text: null };

interface AmendedValueInput {
  entry_id?: string | null;
  legacy_text?: string | null;
}

// What an amendment says of one dimension: a side it leaves out stays as it is, and null removes the dimension.
type AmendedDimensionInput = { prior?: AmendedValueInput; new?: AmendedValueInput } | null;

export type CorrectAssignmentInput = { expected_assignment_version: number; reason?: string | null } & (
  | { action: 'VOID' }
  | {
      action: 'AMEND';
      effective_date?: string | null;
      document_reference?: string | null;
      remark?: string | null;
      changes?: Partial<Record<AssignmentDimension, AmendedDimensionInput>>;
    }
);

type AmendedDimension = { prior?: CorrectedValue; new?: CorrectedValue } | null;

// An amendment once validated: a field it does not name is undefined and stays as it is.
interface AssignmentAmendment {
  effective_date?: string | null;
  document_reference?: string | null;
  remark?: string | null;
  changes: Partial<Record<AssignmentDimension, AmendedDimension>>;
}

// An assignment fact as it stands, under the Asset's lock.
interface StoredEvent {
  kind: 'INITIAL' | 'REASSIGNMENT';
  effective_date: string | null;
  document_reference: string | null;
  remark: string | null;
  is_voided: boolean;
  changes: Partial<Record<AssignmentDimension, NonNullable<CorrectedChange>>>;
}

// The reason every correction needs: nonblank, bounded, and free of control characters (MR-06).
function normalizeReason(value: unknown): string {
  const reason = normalizeText(value, 'reason', REASON_MAX_LENGTH, '');
  if (reason === null) {
    throw new ValidationError('A correction needs a reason');
  }
  return reason;
}

function normalizeValue(value: AmendedValueInput, field: string): CorrectedValue {
  if (value.entry_id !== undefined && value.entry_id !== null && !isValidUuid(value.entry_id)) {
    throw new ValidationError(`${field}.entry_id must be a valid UUID`);
  }
  return {
    entry_id: value.entry_id ? value.entry_id.trim().toLowerCase() : null,
    legacy_text: normalizeText(value.legacy_text, `${field}.legacy_text`, LEGACY_TEXT_MAX_LENGTH, ''),
  };
}

function normalizeAmendment(input: Extract<CorrectAssignmentInput, { action: 'AMEND' }>, today: string): AssignmentAmendment {
  const amendment: AssignmentAmendment = { changes: {} };
  if (input.effective_date !== undefined) {
    amendment.effective_date = normalizeEffectiveDate(input.effective_date, today, '');
  }
  if (input.document_reference !== undefined) {
    amendment.document_reference = normalizeText(input.document_reference, 'document_reference', DOCUMENT_REFERENCE_MAX_LENGTH, '');
  }
  if (input.remark !== undefined) {
    amendment.remark = normalizeText(input.remark, 'remark', REMARK_MAX_LENGTH, '');
  }
  for (const { key } of DIMENSIONS) {
    const dimension = input.changes?.[key];
    if (dimension === null) {
      amendment.changes[key] = null;
    } else if (dimension !== undefined) {
      amendment.changes[key] = {
        ...(dimension.prior && { prior: normalizeValue(dimension.prior, `changes.${key}.prior`) }),
        ...(dimension.new && { new: normalizeValue(dimension.new, `changes.${key}.new`) }),
      };
    }
  }
  return amendment;
}

const sameValue = (a: CorrectedValue, b: CorrectedValue): boolean => a.entry_id === b.entry_id && a.legacy_text === b.legacy_text;

const sameChange = (a: CorrectedChange, b: CorrectedChange): boolean =>
  a === null || b === null ? a === b : sameValue(a.prior, b.prior) && sameValue(a.new, b.new);

const isEmpty = (value: CorrectedValue): boolean => value.entry_id === null && value.legacy_text === null;

// What an amendment leaves of one dimension of an Initial Assignment, which has no prior values (#50
// Q13): an entry or Legacy text, or nothing once the dimension is removed.
function amendedInitialChange(key: AssignmentDimension, stored: CorrectedChange, amendment: NonNullable<AmendedDimension>): CorrectedChange {
  if (amendment.prior) {
    throw new ValidationError('An Initial Assignment has no prior values');
  }
  const newValue = amendment.new ?? stored?.new;
  if (!newValue || isEmpty(newValue)) {
    throw new ValidationError(`An Initial Assignment's ${key} needs an entry or Legacy text; remove the dimension to leave it out`);
  }
  return { prior: NO_VALUE, new: newValue };
}

// What an amendment leaves of one dimension of a Reassignment. Its new value is an entry or, for the
// OrganizationUnit and the Responsible Person, empty (#50 Q15), never Legacy text (Q14). A dimension it
// never changed is recorded as its own Reassignment, and the change stays a real one (MR-01).
function amendedReassignmentChange(key: AssignmentDimension, stored: CorrectedChange, amendment: NonNullable<AmendedDimension>): CorrectedChange {
  if (!stored) {
    throw new ValidationError(`This Reassignment did not change the ${key}; record that change as a Reassignment`);
  }
  if (amendment.new?.legacy_text) {
    throw new ValidationError('A Reassignment names Reference List entries, never Legacy text');
  }
  if (key === 'location' && amendment.new && amendment.new.entry_id === null) {
    throw new ValidationError('A Reassignment cannot empty the Location: name another entry');
  }
  const change = { prior: amendment.prior ?? stored.prior, new: amendment.new ?? stored.new };
  if (sameValue(change.prior, change.new)) {
    throw new ValidationError(`The ${key} would not change: remove the dimension from this fact, or void it`);
  }
  return change;
}

// The event an amendment leaves, as a before and after for every field that differs.
function amendedFields(event: StoredEvent, amendment: AssignmentAmendment): StoredCorrectionField[] {
  if (amendment.effective_date === null && event.kind !== 'INITIAL') {
    throw new ValidationError('A Reassignment has a real Effective Date, never unknown');
  }

  const fields: StoredCorrectionField[] = [];
  for (const field of ['effective_date', 'document_reference', 'remark'] as const) {
    const after = amendment[field];
    if (after !== undefined && after !== event[field]) {
      fields.push({ field, before: event[field], after });
    }
  }

  let remaining = 0;
  for (const { key } of DIMENSIONS) {
    const before: CorrectedChange = event.changes[key] ?? null;
    const dimension = amendment.changes[key];
    let after = before;
    if (dimension === null) {
      if (!before) {
        throw new ValidationError(`This fact has no ${key} to remove`);
      }
      after = null;
    } else if (dimension) {
      after = event.kind === 'INITIAL' ? amendedInitialChange(key, before, dimension) : amendedReassignmentChange(key, before, dimension);
    }
    remaining += after ? 1 : 0;
    if (!sameChange(before, after)) {
      fields.push({ field: key, before, after });
    }
  }
  if (remaining === 0) {
    throw new ValidationError('A fact needs at least one dimension: void it instead');
  }
  if (fields.length === 0) {
    throw new ValidationError('This amendment changes nothing');
  }
  return fields;
}

async function readStoredEvent(client: pg.PoolClient, assetId: string, eventId: string): Promise<StoredEvent> {
  const eventRes = await client.query(
    `SELECT kind, to_char(effective_date, 'YYYY-MM-DD') AS effective_date, document_reference, remark, is_voided
     FROM assignment_events WHERE id = $1 AND asset_id = $2`,
    [eventId, assetId]
  );
  if (eventRes.rows.length === 0) {
    throw new NotFoundError('Assignment fact not found');
  }
  const changesRes = await client.query('SELECT * FROM assignment_changes WHERE event_id = $1', [eventId]);
  const changes: StoredEvent['changes'] = {};
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

// The entries an amendment names must each be in their own dimension's list; deactivated ones are
// allowed (#50 Q16).
async function assertAmendedEntries(client: pg.PoolClient, amendment: AssignmentAmendment): Promise<void> {
  for (const side of ['prior', 'new'] as const) {
    const ids = Object.fromEntries(
      DIMENSIONS.map(({ key, idField }) => [idField, amendment.changes[key]?.[side]?.entry_id ?? null])
    );
    await assertAssignableEntries(client, ids, true, ` (${side} value)`);
  }
}

async function writeChange(
  client: pg.PoolClient,
  eventId: string,
  kind: StoredEvent['kind'],
  key: AssignmentDimension,
  after: CorrectedChange
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
 * F003-T3 (#53): fixes one assignment fact that was recorded wrong. An amendment leaves the corrected
 * values on the event and its changes, and voiding keeps the fact in the timeline and out of the
 * Current Assignment (MR-07). Each correction keeps its reason and its before and after, is not a
 * business event (MR-06), and writes as every assignment write does.
 */
export class AssignmentCorrectionService {
  private readonly db: pg.Pool | any;
  private readonly clock: () => Date;

  constructor(options: { db: pg.Pool | any; clock?: () => Date }) {
    this.db = options.db;
    this.clock = options.clock ?? (() => new Date());
  }

  async correct(
    actorId: string,
    assetId: string,
    eventId: string,
    input: CorrectAssignmentInput,
    { retryToken }: { retryToken: string }
  ): Promise<RecordedAssignment> {
    const reason = normalizeReason(input.reason);
    const amendment = input.action === 'AMEND' ? normalizeAmendment(input, bangkokDate(this.clock())) : null;
    return writeAssignmentOnce(
      this.db,
      {
        actorId,
        assetId,
        operation: `assignment:correct:${assetId}:${eventId}`,
        retryToken,
        expectedVersion: input.expected_assignment_version,
        payload: { version: 1, action: input.action, expected_assignment_version: input.expected_assignment_version, reason, amendment },
      },
      async (client) => {
        const event = await readStoredEvent(client, assetId, eventId);
        if (event.is_voided) {
          throw new ValidationError('This fact is voided: it can no longer be corrected');
        }
        if (amendment) {
          await this.amend(client, eventId, event, amendment, reason, actorId);
        } else {
          await client.query('UPDATE assignment_events SET is_voided = true WHERE id = $1', [eventId]);
          await this.keepCorrection(client, eventId, 'VOIDED', reason, [], actorId);
        }
        await client.query('UPDATE assets SET assignment_version = assignment_version + 1 WHERE id = $1', [assetId]);
        return eventId;
      }
    );
  }

  private async amend(
    client: pg.PoolClient,
    eventId: string,
    event: StoredEvent,
    amendment: AssignmentAmendment,
    reason: string,
    actorId: string
  ): Promise<void> {
    const fields = amendedFields(event, amendment);
    await assertAmendedEntries(client, amendment);
    const corrected = { ...event };
    for (const field of fields) {
      if (isDimensionField(field)) {
        await writeChange(client, eventId, event.kind, field.field, field.after);
      } else {
        corrected[field.field] = field.after;
      }
    }
    await client.query('UPDATE assignment_events SET effective_date = $2, document_reference = $3, remark = $4 WHERE id = $1', [
      eventId,
      corrected.effective_date,
      corrected.document_reference,
      corrected.remark,
    ]);
    await this.keepCorrection(client, eventId, 'AMENDED', reason, fields, actorId);
  }

  private async keepCorrection(
    client: pg.PoolClient,
    eventId: string,
    action: 'AMENDED' | 'VOIDED',
    reason: string,
    fields: StoredCorrectionField[],
    actorId: string
  ): Promise<void> {
    await client.query(
      `INSERT INTO assignment_corrections (event_id, action, reason, changes, recorded_by)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [eventId, action, reason, JSON.stringify(fields), actorId]
    );
  }
}
