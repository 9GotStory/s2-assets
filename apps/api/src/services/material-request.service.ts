import pg from 'pg';
import { normalizeText } from './assignment.service.ts';
import { isValidUuid } from './capability.service.ts';
import { formatDecimal, isWhole, parseDecimal } from './exact-decimal.ts';
import { requestableMaterialsAskedFor } from './requestable-material-asked-for.ts';
import { commitOnce } from './retryable-write.ts';
import { ValidationError } from './validation-error.ts';

// #202 Q10, P7: a Material Request holds 1 to 50 Requested Items; its note is at most 2000 characters and each
// Requested Item's note at most 500.
export const MAX_REQUESTED_ITEMS = 50;
export const MATERIAL_REQUEST_NOTE_MAX_LENGTH = 2000;
export const REQUESTED_ITEM_NOTE_MAX_LENGTH = 500;

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
}
