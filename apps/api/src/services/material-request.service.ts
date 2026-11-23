import pg from 'pg';
import { normalizeText } from './assignment.service.ts';
import { isValidUuid } from './capability.service.ts';
import { formatDecimal, isWhole, parseDecimal } from './exact-decimal.ts';
import { materialRequestState, requestedItemState, type MaterialRequestState } from './material-request-state.ts';
import { requestableMaterialsAskedFor } from './requestable-material-asked-for.ts';
import { commitOnce } from './retryable-write.ts';
import { NotFoundError, StaleBeforeConflictError } from './service-errors.ts';
import { ValidationError } from './validation-error.ts';

// #202 Q10, P7: a Material Request holds 1 to 50 Requested Items; its note is at most 2000 characters and each
// Requested Item's note at most 500.
export const MAX_REQUESTED_ITEMS = 50;
export const MATERIAL_REQUEST_NOTE_MAX_LENGTH = 2000;
export const REQUESTED_ITEM_NOTE_MAX_LENGTH = 500;
// P7: a Cancel's note is at most 500 characters.
export const CANCEL_NOTE_MAX_LENGTH = 500;

export interface RequestedItemInput {
  requestable_material_id: string;
  // A decimal string in the Request Unit, at most four decimal places (#175 P1).
  requested_quantity: string;
  note?: string | null;
}

export interface CreateMaterialRequestInput {
  note?: string | null;
  requested_items: RequestedItemInput[];
}

// What creating a Material Request answers: the Material Request, its Request Number and the version a Cancel expects.
export interface MaterialRequestCreated {
  material_request_id: string;
  // A bigint, as a string of digits (P3).
  request_number: string;
  version: number;
}

// F009-T5 (#207): a Cancel, at the version of the Material Request the request read (P4), with an optional note.
export interface CancelInput {
  expected_version: number;
  note?: string | null;
}

// What a Cancel answers: the Material Request and the version it moved to.
export interface MaterialRequestVersion {
  material_request_id: string;
  version: number;
}

// The current state a Cancel is refused with (Q20, P4; #207 start decision 1): the Material Request's version and
// state, and the Requested Item's state on a Requested Item's Cancel.
type CurrentState = { version: number; state: MaterialRequestState; requested_item_state?: MaterialRequestState };

/**
 * F009-T5 (#207): a Cancel of a Requested Item already Cancelled, or of a Material Request with no Pending Requested
 * Item left, at the version the request read (Q20; #207 start decision 1). Like a stale refusal it carries the current
 * state and the version expected (#207 review decision 1).
 */
export class NotPendingError extends Error {
  statusCode = 409;
  code = 'NOT_PENDING';
  current_values: CurrentState;
  expected_values: { version: number };

  constructor(message: string, currentValues: CurrentState, expectedVersion: number) {
    super(message);
    this.name = 'NotPendingError';
    this.current_values = currentValues;
    this.expected_values = { version: expectedVersion };
  }
}

/** A Requested Item asking for a Requestable Material Requesters are not offered (#202 Q9, Q20), named by its position. */
export class RequestableMaterialNotOfferedError extends Error {
  statusCode = 409;
  code = 'NOT_OFFERED';
  position: number;

  constructor(position: number) {
    super(`requested_items[${position}] asks for a Requestable Material that is not offered: it is Inactive or has no Compatible Stock Material`);
    this.name = 'RequestableMaterialNotOfferedError';
    this.position = position;
  }
}

// A Requested Quantity once read: greater than 0, at most four decimal places, never rounded (#202 Q10), as a count of
// ten-thousandths.
const requestedQuantityOf = (value: string, field: string): bigint => {
  const parsed = parseDecimal(value);
  if (!parsed.ok) {
    const reasons = {
      NOT_A_DECIMAL: 'must be a decimal number',
      TOO_MANY_DECIMAL_PLACES: 'must have at most four decimal places',
      OUT_OF_RANGE: 'is too large',
    };
    throw new ValidationError(`${field} ${reasons[parsed.reason]}`);
  }
  if (parsed.scaled <= 0n) {
    throw new ValidationError(`${field} must be greater than 0`);
  }
  return parsed.scaled;
};

// A request's facts once validated, before any lock. The retry fingerprint covers these.
const normalizeFacts = (input: CreateMaterialRequestInput) => {
  if (input.requested_items.length === 0) {
    throw new ValidationError('requested_items must hold at least one Requested Item');
  }
  if (input.requested_items.length > MAX_REQUESTED_ITEMS) {
    throw new ValidationError(`requested_items must hold at most ${MAX_REQUESTED_ITEMS} Requested Items`);
  }
  const positions = new Map<string, number>();
  const requestedItems = input.requested_items.map((requested, position) => {
    const field = `requested_items[${position}]`;
    if (!isValidUuid(requested.requestable_material_id)) {
      throw new ValidationError(`${field}.requestable_material_id must be a valid UUID`);
    }
    const requestableMaterialId = requested.requestable_material_id.trim().toLowerCase();
    const earlier = positions.get(requestableMaterialId);
    if (earlier !== undefined) {
      throw new ValidationError(`${field}.requestable_material_id repeats the Requestable Material of requested_items[${earlier}]`);
    }
    positions.set(requestableMaterialId, position);
    return {
      requestable_material_id: requestableMaterialId,
      // Stored and fingerprinted as the exact value asked for, so "2" and "2.0" are one request.
      requested_quantity: formatDecimal(requestedQuantityOf(requested.requested_quantity, `${field}.requested_quantity`)),
      // Free text, keeping tab and line breaks inside it.
      note: normalizeText(requested.note, `${field}.note`, REQUESTED_ITEM_NOTE_MAX_LENGTH, ''),
    };
  });
  return { note: normalizeText(input.note, 'note', MATERIAL_REQUEST_NOTE_MAX_LENGTH, ''), requested_items: requestedItems };
};

// Locks the Material Request `id` FOR UPDATE, so its Cancels take turns (P4), and answers its version; another
// person's answers as if it did not exist (Q12, P5). What the Cancel reads next comes in later statements, so that
// it sees what a Cancel committed while this one waited.
const lockedOwn = async (client: pg.PoolClient, actorId: string, id: string): Promise<number> => {
  const res = await client.query('SELECT version, requested_by FROM material_requests WHERE id = $1 FOR UPDATE', [id]);
  const stored = res.rows[0];
  if (!stored || stored.requested_by !== actorId) {
    throw new NotFoundError('Material Request not found');
  }
  return stored.version;
};

// The state of the Material Request `id`, from the one SQL source (P10).
const stateOf = async (client: pg.PoolClient, id: string): Promise<MaterialRequestState> =>
  (await client.query(`SELECT ${materialRequestState('m')} AS state FROM material_requests m WHERE m.id = $1`, [id])).rows[0].state;

// Refuses a Cancel at a version other than the one the Material Request has (Q20, P4).
const refuseStale = (current: CurrentState, expectedVersion: number): void => {
  if (current.version !== expectedVersion) {
    throw new StaleBeforeConflictError('The Material Request changed since it was read', current, { version: expectedVersion });
  }
};

// Cancels the Requested Items `ids` of the Material Request `id` with `note`, moves it to its next version with one
// history entry of `kind` naming them, and answers that version. Nothing is deleted (MRQ-19).
const recordCancel = async (
  client: pg.PoolClient,
  actorId: string,
  id: string,
  kind: 'REQUESTED_ITEM_CANCELLED' | 'MATERIAL_REQUEST_CANCELLED',
  ids: string[],
  note: string | null
): Promise<MaterialRequestVersion> => {
  await client.query('UPDATE requested_items SET cancelled_by = $2, cancelled_at = now(), cancel_note = $3 WHERE id = ANY($1::uuid[])', [ids, actorId, note]);
  const { version } = (await client.query('UPDATE material_requests SET version = version + 1 WHERE id = $1 RETURNING version', [id])).rows[0];
  await client.query(
    'INSERT INTO material_request_history (material_request_id, version, kind, requested_item_ids, note, recorded_by) VALUES ($1, $2, $3, $4::uuid[], $5, $6)',
    [id, version, kind, ids, note, actorId]
  );
  return { material_request_id: id, version };
};

/**
 * F009-T4 (#206): creating a Material Request (คำขอเบิก), the Requester's request for Requestable Materials in the
 * words of their work (#202 MRQ-01, MRQ-16, MRQ-28, Q10). It changes no stock (MRQ-05, MRQ-07). The reads are in
 * material-request-read.service.ts.
 */
export class MaterialRequestService {
  private readonly db: pg.Pool | any;

  constructor(options: { db: pg.Pool | any }) {
    this.db = options.db;
  }

  /**
   * Creates a Material Request of `input.requested_items` by `actorId` (Q3), each Requested Item Pending, under a Request
   * Number from the sequence (Q14). Each Requestable Material must be offered at the moment of saving (Q9, Q20), and its
   * Requested Quantity whole when it counts in whole numbers (Q10); each Requested Item records the Request Unit (P3).
   */
  async create(actorId: string, input: CreateMaterialRequestInput, { retryToken }: { retryToken: string }): Promise<MaterialRequestCreated> {
    const facts = normalizeFacts(input);
    return commitOnce(this.db, { actorId, operation: 'material-request:create', retryToken, payload: facts, explicitContinuation: false }, async (client) => {
      const asked = await requestableMaterialsAskedFor(
        client,
        facts.requested_items.map(({ requestable_material_id }) => requestable_material_id)
      );
      const requestUnits = facts.requested_items.map((requested, position) => {
        const field = `requested_items[${position}]`;
        const requestable = asked.get(requested.requestable_material_id);
        if (requestable === undefined) {
          throw new ValidationError(`${field}.requestable_material_id must name a Requestable Material`);
        }
        if (!requestable.is_offered) {
          throw new RequestableMaterialNotOfferedError(position);
        }
        // The quantity was read once already, so reading it again cannot refuse it.
        if (requestable.whole_number_only && !isWhole(requestedQuantityOf(requested.requested_quantity, `${field}.requested_quantity`))) {
          throw new ValidationError(`${field}.requested_quantity must be a whole number, as its Requestable Material counts in whole numbers`);
        }
        return requestable.request_unit_id;
      });

      const res = await client.query('INSERT INTO material_requests (requested_by, note) VALUES ($1, $2) RETURNING id, request_number::text, version', [actorId, facts.note]);
      const { id, request_number: requestNumber, version } = res.rows[0];
      await client.query(
        `INSERT INTO requested_items (material_request_id, position, requestable_material_id, requested_quantity, request_unit_id, note)
         SELECT $1, item.position - 1, item.requestable_material_id, item.requested_quantity, item.request_unit_id, item.note
         FROM unnest($2::uuid[], $3::numeric[], $4::uuid[], $5::text[]) WITH ORDINALITY AS item(requestable_material_id, requested_quantity, request_unit_id, note, position)`,
        [
          id,
          facts.requested_items.map(({ requestable_material_id }) => requestable_material_id),
          facts.requested_items.map(({ requested_quantity }) => requested_quantity),
          requestUnits,
          facts.requested_items.map(({ note }) => note),
        ]
      );
      await client.query(`INSERT INTO material_request_history (material_request_id, version, kind, recorded_by) VALUES ($1, $2, 'CREATED', $3)`, [id, version, actorId]);
      return { material_request_id: id, request_number: requestNumber, version };
    });
  }
  /**
   * F009-T5 (#207): Cancels the Pending Requested Item `itemId` of the Material Request `requestId` that `actorId`
   * created, with an optional note (MRQ-19, Q12, P4).
   */
  async cancelRequestedItem(actorId: string, requestId: string, itemId: string, input: CancelInput, { retryToken }: { retryToken: string }): Promise<MaterialRequestVersion> {
    const note = normalizeText(input.note, 'note', CANCEL_NOTE_MAX_LENGTH, '');
    const payload = { material_request_id: requestId, requested_item_id: itemId, expected_version: input.expected_version, note };
    return commitOnce(this.db, { actorId, operation: 'requested-item:cancel', retryToken, payload, explicitContinuation: false }, async (client) => {
      const version = await lockedOwn(client, actorId, requestId);
      const res = await client.query(`SELECT ${requestedItemState('i')} AS state FROM requested_items i WHERE i.id = $1 AND i.material_request_id = $2`, [itemId, requestId]);
      if (res.rows.length === 0) {
        throw new NotFoundError('Requested Item not found');
      }
      const current: CurrentState = { version, state: await stateOf(client, requestId), requested_item_state: res.rows[0].state };
      refuseStale(current, input.expected_version);
      if (current.requested_item_state !== 'PENDING') {
        throw new NotPendingError('The Requested Item is already Cancelled', current, input.expected_version);
      }
      return recordCancel(client, actorId, requestId, 'REQUESTED_ITEM_CANCELLED', [itemId], note);
    });
  }

  /**
   * F009-T5 (#207): Cancels every Pending Requested Item of the Material Request `requestId` that `actorId` created, in
   * one transaction with one note and one history entry naming them (MRQ-19, Q12, Q20, P4).
   */
  async cancelMaterialRequest(actorId: string, requestId: string, input: CancelInput, { retryToken }: { retryToken: string }): Promise<MaterialRequestVersion> {
    const note = normalizeText(input.note, 'note', CANCEL_NOTE_MAX_LENGTH, '');
    const payload = { material_request_id: requestId, expected_version: input.expected_version, note };
    return commitOnce(this.db, { actorId, operation: 'material-request:cancel', retryToken, payload, explicitContinuation: false }, async (client) => {
      const version = await lockedOwn(client, actorId, requestId);
      const pending = await client.query(
        `SELECT i.id FROM requested_items i WHERE i.material_request_id = $1 AND ${requestedItemState('i')} = 'PENDING' ORDER BY i.position ASC`,
        [requestId]
      );
      const current: CurrentState = { version, state: await stateOf(client, requestId) };
      refuseStale(current, input.expected_version);
      if (pending.rows.length === 0) {
        throw new NotPendingError('The Material Request has no Pending Requested Item', current, input.expected_version);
      }
      return recordCancel(client, actorId, requestId, 'MATERIAL_REQUEST_CANCELLED', pending.rows.map(({ id }: { id: string }) => id), note);
    });
  }
}
