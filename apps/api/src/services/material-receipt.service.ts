import pg from 'pg';
import { bangkokDate, isCalendarDate, normalizeText } from './assignment.service.ts';
import { normalizeQuantity } from './base-quantity.ts';
import { catalogListHolds, lockedCatalogListEntry } from './catalog-list.service.ts';
import { CATALOG_LISTS } from './catalog-list-entries.ts';
import { parseDecimal } from './exact-decimal.ts';
import { materialReceiptState, type MaterialReceiptState } from './material-receipt-state.ts';
import { openingBalancesInEffectOf, type InEffectOpeningBalance } from './opening-balance-read.service.ts';
import { commitOnce } from './retryable-write.ts';
import { NotFoundError, StaleBeforeConflictError } from './service-errors.ts';
import { draftQuantityOf, QUANTITY_REFUSALS, uuidOf, uuidOrNull } from './stock-line-input.ts';
import { lockedStockMaterialsForStock, stockMaterialSummariesOf, stockMaterialUnitsOf } from './stock-material-read.service.ts';
import { recordStockMovement } from './stock-movements.ts';
import { ValidationError } from './validation-error.ts';

// #231 Q9, P7: a Material Receipt holds 0 to 50 Receipt Lines; its Receipt Reference is at most 500 characters, its
// note at most 2000, and a line's note at most 500.
export const MAX_RECEIPT_LINES = 50;
export const RECEIPT_REFERENCE_MAX_LENGTH = 500;
export const MATERIAL_RECEIPT_NOTE_MAX_LENGTH = 2000;
export const RECEIPT_LINE_NOTE_MAX_LENGTH = 500;

export interface ReceiptLineInput {
  stock_material_id: string;
  unit_id?: string | null;
  // Decimal strings, at most four decimal places (#175 P1): the quantity in the Unit, the Unit Price per Unit.
  quantity?: string | null;
  unit_price?: string | null;
  note?: string | null;
}

// A Draft as saved, which may be incomplete (Q25; #234 start decision 1).
export interface MaterialReceiptDraftInput {
  received_date?: string | null;
  source_party_id?: string | null;
  source_type_id?: string | null;
  receipt_reference?: string | null;
  note?: string | null;
  lines: ReceiptLineInput[];
}

export interface ReplaceDraftInput extends MaterialReceiptDraftInput {
  expected_version: number;
}

export interface ExpectedVersionInput {
  expected_version: number;
}

// What a create or a replace answers: the Material Receipt and the version a later write expects.
export interface MaterialReceiptVersion {
  material_receipt_id: string;
  version: number;
}

// What a confirm answers, with the number it took: a bigint as a string of digits (P1).
export interface MaterialReceiptConfirmed extends MaterialReceiptVersion {
  receipt_number: string;
}

type CurrentState = { version: number; state: MaterialReceiptState };

/** A replace, a remove or a confirm of a Material Receipt already Received, at the version it has (Q4). */
export class MaterialReceiptNotDraftError extends Error {
  statusCode = 409;
  code = 'NOT_DRAFT';
  current_values: CurrentState;
  expected_values: { version: number };

  constructor(currentValues: CurrentState, expectedValues: { version: number }) {
    super('The Material Receipt is Received: only a Draft can be replaced, removed or confirmed');
    this.name = 'MaterialReceiptNotDraftError';
    this.current_values = currentValues;
    this.expected_values = expectedValues;
  }
}

// One reason a confirm is refused, named by its field: `received_date`, `source_party_id`, `source_type_id`, `lines`,
// or `lines[<i>].<field>`.
export interface ReceiptConfirmProblem {
  field: string;
  message: string;
  // For a line whose Stock Material has an Opening Balance in effect as of the Received Date or later (Q21).
  in_effect_opening_balance?: InEffectOpeningBalance;
}

/** A confirm refused, with every failing rule and line named (#231 Q25). Nothing is written. */
export class MaterialReceiptNotConfirmableError extends Error {
  statusCode = 409;
  code = 'NOT_CONFIRMABLE';
  problems: ReceiptConfirmProblem[];

  constructor(problems: ReceiptConfirmProblem[]) {
    super(`The Material Receipt cannot be confirmed: ${problems.map(({ message }) => message).join('; ')}`);
    this.name = 'MaterialReceiptNotConfirmableError';
    this.problems = problems;
  }
}

// A Unit Price present on a Draft line: at least 0, at most four decimal places, never rounded (Q8).
const unitPriceOf = (value: string, field: string): string => {
  const parsed = parseDecimal(value);
  if (!parsed.ok) {
    throw new ValidationError(`${field} ${QUANTITY_REFUSALS[parsed.reason]}`);
  }
  if (parsed.scaled < 0n) {
    throw new ValidationError(`${field} must be at least 0`);
  }
  return value;
};

// A Draft's facts once validated, before any lock. The retry fingerprint covers these.
const normalizeDraft = (input: MaterialReceiptDraftInput) => {
  let receivedDate: string | null = null;
  if (input.received_date !== undefined && input.received_date !== null) {
    if (!isCalendarDate(input.received_date)) {
      throw new ValidationError('received_date must be a date (YYYY-MM-DD)');
    }
    receivedDate = input.received_date;
  }
  if (input.lines.length > MAX_RECEIPT_LINES) {
    throw new ValidationError(`lines must hold at most ${MAX_RECEIPT_LINES} lines`);
  }
  const pairs = new Map<string, number>();
  const lines = input.lines.map((line, position) => {
    const field = `lines[${position}]`;
    // The route requires it as a string (material-receipt.routes.ts).
    const stockMaterialId = uuidOf(line.stock_material_id, `${field}.stock_material_id`);
    const unitId = uuidOrNull(line.unit_id, `${field}.unit_id`);
    // A Stock Material twice only in different Units (Q9); a line without its Unit yet names no pair (#234 start
    // decision 1).
    if (unitId !== null) {
      const pair = `${stockMaterialId} ${unitId}`;
      const earlier = pairs.get(pair);
      if (earlier !== undefined) {
        throw new ValidationError(`${field}.unit_id repeats the Stock Material and Unit of lines[${earlier}]`);
      }
      pairs.set(pair, position);
    }
    return {
      stock_material_id: stockMaterialId,
      unit_id: unitId,
      quantity: line.quantity === undefined || line.quantity === null ? null : draftQuantityOf(line.quantity, `${field}.quantity`),
      unit_price: line.unit_price === undefined || line.unit_price === null ? null : unitPriceOf(line.unit_price, `${field}.unit_price`),
      note: normalizeText(line.note, `${field}.note`, RECEIPT_LINE_NOTE_MAX_LENGTH, ''),
    };
  });
  return {
    received_date: receivedDate,
    source_party_id: uuidOrNull(input.source_party_id, 'source_party_id'),
    source_type_id: uuidOrNull(input.source_type_id, 'source_type_id'),
    receipt_reference: normalizeText(input.receipt_reference, 'receipt_reference', RECEIPT_REFERENCE_MAX_LENGTH, ''),
    note: normalizeText(input.note, 'note', MATERIAL_RECEIPT_NOTE_MAX_LENGTH, ''),
    lines,
  };
};

type DraftFacts = ReturnType<typeof normalizeDraft>;

// The lists a Material Receipt names, by the field that names an entry of each.
const RECEIPT_LISTS = [
  { field: 'source_party_id', kind: 'source-party' },
  { field: 'source_type_id', kind: 'source-type' },
] as const;

/**
 * Refuses a Draft naming what does not exist: a Stock Material, a Unit its Stock Material does not have, a Source Party
 * or a Source Type. An Inactive Unit, Source Party or Source Type waits for confirm, since it can be made active again
 * first (#234 start decision 1).
 */
const refuseUnknownChoices = async (client: pg.PoolClient, facts: DraftFacts): Promise<void> => {
  for (const { field, kind } of RECEIPT_LISTS) {
    const id = facts[field];
    if (id !== null && !(await catalogListHolds(client, kind, id))) {
      throw new ValidationError(`${field} must name a ${CATALOG_LISTS[kind].concept}`);
    }
  }
  const summaries = await stockMaterialSummariesOf(
    client,
    facts.lines.map(({ stock_material_id }) => stock_material_id)
  );
  const unitsOf = new Map(summaries.map((summary) => [summary.stock_material_id, summary.units]));
  facts.lines.forEach((line, position) => {
    const units = unitsOf.get(line.stock_material_id);
    if (units === undefined) {
      throw new ValidationError(`lines[${position}].stock_material_id must name a Stock Material`);
    }
    if (line.unit_id !== null && !units.some(({ unit_id }) => unit_id === line.unit_id)) {
      throw new ValidationError(`lines[${position}].unit_id must name a Unit of its Stock Material`);
    }
  });
};

const insertLines = async (client: pg.PoolClient, id: string, facts: DraftFacts): Promise<void> => {
  await client.query(
    `INSERT INTO material_receipt_lines (material_receipt_id, position, stock_material_id, unit_id, quantity, unit_price, note)
     SELECT $1, line.position - 1, line.stock_material_id, line.unit_id, line.quantity, line.unit_price, line.note
     FROM unnest($2::uuid[], $3::uuid[], $4::numeric[], $5::numeric[], $6::text[])
          WITH ORDINALITY AS line(stock_material_id, unit_id, quantity, unit_price, note, position)`,
    [
      id,
      facts.lines.map(({ stock_material_id }) => stock_material_id),
      facts.lines.map(({ unit_id }) => unit_id),
      facts.lines.map(({ quantity }) => quantity),
      facts.lines.map(({ unit_price }) => unit_price),
      facts.lines.map(({ note }) => note),
    ]
  );
};

/**
 * Locks the Material Receipt `id` FOR UPDATE, so its replace, remove and confirm take turns (#231 P4), and refuses it
 * when there is none, when its version is not `expectedVersion`, or when it is no longer a Draft, in that order.
 */
const lockedDraft = async (client: pg.PoolClient, id: string, expectedVersion: number): Promise<CurrentState> => {
  const res = await client.query(`SELECT version, ${materialReceiptState('material_receipts')} AS state FROM material_receipts WHERE id = $1 FOR UPDATE`, [id]);
  const current: CurrentState | undefined = res.rows[0];
  if (!current) {
    throw new NotFoundError('Material Receipt not found');
  }
  if (current.version !== expectedVersion) {
    throw new StaleBeforeConflictError('The Material Receipt changed since it was read', current, { version: expectedVersion });
  }
  if (current.state !== 'DRAFT') {
    throw new MaterialReceiptNotDraftError(current, { version: expectedVersion });
  }
  return current;
};

// A stored Draft line, as a confirm reads it.
interface StoredLine {
  id: string;
  position: number;
  stock_material_id: string;
  unit_id: string | null;
  quantity: string | null;
  unit_price: string | null;
  note: string | null;
}

/**
 * F010-T3 (#234): the Material Receipt (รายการรับวัสดุ): its Draft, kept by any Supply Officer, and its confirm
 * (ยืนยันรับวัสดุ), which gives it its Receipt Number and adds its Stock Movements (#231 MRC-01–MRC-03, MRC-05–MRC-09,
 * Q4–Q11, Q21, Q24–Q26). The reads are in material-receipt-read.service.ts.
 */
export class MaterialReceiptService {
  private readonly db: pg.Pool | any;
  private readonly clock: () => Date;

  constructor(options: { db: pg.Pool | any; clock?: () => Date }) {
    this.db = options.db;
    this.clock = options.clock ?? (() => new Date());
  }

  /** Saves a new Draft of `input` by `actorId`, at version 1. */
  async create(actorId: string, input: MaterialReceiptDraftInput, { retryToken }: { retryToken: string }): Promise<MaterialReceiptVersion> {
    const facts = normalizeDraft(input);
    return commitOnce(this.db, { actorId, operation: 'material-receipt:create', retryToken, payload: facts, explicitContinuation: false }, async (client) => {
      await refuseUnknownChoices(client, facts);
      const res = await client.query(
        `INSERT INTO material_receipts (received_date, source_party_id, source_type_id, receipt_reference, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, version`,
        [facts.received_date, facts.source_party_id, facts.source_type_id, facts.receipt_reference, facts.note, actorId]
      );
      const { id, version } = res.rows[0];
      await insertLines(client, id, facts);
      return { material_receipt_id: id, version };
    });
  }

  /**
   * Replaces the whole Draft `id` with `input` at the version the request read, and moves it to its next version, even
   * when nothing differs (#234 start decision 2). A Draft has no history (P1).
   */
  async replace(actorId: string, id: string, input: ReplaceDraftInput, { retryToken }: { retryToken: string }): Promise<MaterialReceiptVersion> {
    const facts = normalizeDraft(input);
    const payload = { material_receipt_id: id, expected_version: input.expected_version, ...facts };
    return commitOnce(this.db, { actorId, operation: 'material-receipt:replace', retryToken, payload, explicitContinuation: false }, async (client) => {
      await lockedDraft(client, id, input.expected_version);
      await refuseUnknownChoices(client, facts);
      await client.query('DELETE FROM material_receipt_lines WHERE material_receipt_id = $1', [id]);
      await insertLines(client, id, facts);
      const res = await client.query(
        `UPDATE material_receipts SET received_date = $2, source_party_id = $3, source_type_id = $4, receipt_reference = $5, note = $6, version = version + 1
         WHERE id = $1 RETURNING version`,
        [id, facts.received_date, facts.source_party_id, facts.source_type_id, facts.receipt_reference, facts.note]
      );
      return { material_receipt_id: id, version: res.rows[0].version };
    });
  }

  /** Removes the Draft `id` with its lines for good, at the version the request read: it leaves no record (Q4). */
  async remove(actorId: string, id: string, input: ExpectedVersionInput, { retryToken }: { retryToken: string }): Promise<{ material_receipt_id: string }> {
    const payload = { material_receipt_id: id, expected_version: input.expected_version };
    return commitOnce(this.db, { actorId, operation: 'material-receipt:remove', retryToken, payload, explicitContinuation: false }, async (client) => {
      await lockedDraft(client, id, input.expected_version);
      await client.query('DELETE FROM material_receipt_lines WHERE material_receipt_id = $1', [id]);
      await client.query('DELETE FROM material_receipts WHERE id = $1', [id]);
      return { material_receipt_id: id };
    });
  }

  /**
   * Confirms the Draft `id` at the version the request read (ยืนยันรับวัสดุ): rechecks it all under the lock order (P4),
   * then, in one transaction, gives it the next Receipt Number, adds one Stock Movement per line on its Received Date,
   * and records the confirmed history entry with names as they are now (#175 P6).
   */
  async confirm(actorId: string, id: string, input: ExpectedVersionInput, { retryToken }: { retryToken: string }): Promise<MaterialReceiptConfirmed> {
    const payload = { material_receipt_id: id, expected_version: input.expected_version };
    return commitOnce(this.db, { actorId, operation: 'material-receipt:confirm', retryToken, payload, explicitContinuation: false }, async (client) => {
      // 1. The Material Receipt.
      await lockedDraft(client, id, input.expected_version);
      const header = (
        await client.query('SELECT received_date::text AS received_date, source_party_id, source_type_id, receipt_reference, note FROM material_receipts WHERE id = $1', [id])
      ).rows[0];
      const lines: StoredLine[] = (
        await client.query(
          `SELECT id, position, stock_material_id, unit_id, trim_scale(quantity)::text AS quantity, trim_scale(unit_price)::text AS unit_price, note
           FROM material_receipt_lines WHERE material_receipt_id = $1 ORDER BY position`,
          [id]
        )
      ).rows;
      // 2. Its Stock Materials, by id; 3. their Units' list entries, then its Source Party and Source Type, each read in
      // a statement after the lock.
      const materialIds = [...new Set(lines.map(({ stock_material_id }) => stock_material_id))];
      const names = await lockedStockMaterialsForStock(client, materialIds);
      const units = new Map(await Promise.all(materialIds.map(async (materialId) => [materialId, await stockMaterialUnitsOf(client, materialId, { locked: true })] as const)));
      const sourceParty = header.source_party_id === null ? null : await lockedCatalogListEntry(client, 'source-party', header.source_party_id);
      const sourceType = header.source_type_id === null ? null : await lockedCatalogListEntry(client, 'source-type', header.source_type_id);
      const openingBalances = await openingBalancesInEffectOf(client, materialIds);

      const problems: ReceiptConfirmProblem[] = [];
      const today = bangkokDate(this.clock());
      if (header.received_date === null) {
        problems.push({ field: 'received_date', message: 'received_date is required' });
      } else if (header.received_date > today) {
        problems.push({ field: 'received_date', message: `received_date must not be after today (${today}, Asia/Bangkok)` });
      }
      for (const [field, entry, concept] of [
        ['source_party_id', sourceParty, 'Source Party'],
        ['source_type_id', sourceType, 'Source Type'],
      ] as const) {
        if (entry !== null && !entry.is_active) {
          problems.push({ field, message: `${field} names ${entry.name}, a ${concept} that is Inactive` });
        }
      }
      if (lines.length === 0) {
        problems.push({ field: 'lines', message: 'lines must hold at least one line' });
      }
      const movements = lines.map((line) => {
        const field = `lines[${line.position}]`;
        const openingBalance = openingBalances.get(line.stock_material_id);
        // Q21: a delivery already counted in the Opening Balance is never counted twice.
        if (openingBalance !== undefined && header.received_date !== null && header.received_date <= openingBalance.as_of_date) {
          problems.push({
            field: `${field}.stock_material_id`,
            message: `${field}.stock_material_id names ${names.get(line.stock_material_id)!}, whose Opening Balance ${openingBalance.opening_balance_number} is as of ${openingBalance.as_of_date}: received_date must be after it`,
            in_effect_opening_balance: openingBalance,
          });
        }
        if (line.unit_id === null) {
          problems.push({ field: `${field}.unit_id`, message: `${field}.unit_id is required` });
        }
        if (line.quantity === null) {
          problems.push({ field: `${field}.quantity`, message: `${field}.quantity is required` });
        }
        if (line.unit_id === null || line.quantity === null) {
          return null;
        }
        const materialUnits = units.get(line.stock_material_id)!;
        if (materialUnits.some(({ unit_id, is_active }) => unit_id === line.unit_id && !is_active)) {
          problems.push({ field: `${field}.unit_id`, message: `${field}.unit_id names a Unit that is not active on its Stock Material` });
        }
        const normalized = normalizeQuantity(materialUnits, line.unit_id, line.quantity);
        if (!normalized.ok) {
          problems.push({ field: `${field}.quantity`, message: `${field}.quantity ${QUANTITY_REFUSALS[normalized.reason]}` });
          return null;
        }
        return { line, normalized };
      });
      if (problems.length > 0) {
        throw new MaterialReceiptNotConfirmableError(problems);
      }

      const confirmed = await client.query(
        `UPDATE material_receipts SET receipt_number = nextval('material_receipt_numbers'), confirmed_by = $2, confirmed_at = now(), version = version + 1
         WHERE id = $1 RETURNING receipt_number::text, version`,
        [id, actorId]
      );
      const { receipt_number: number, version } = confirmed.rows[0];
      for (const movement of movements) {
        const { line, normalized } = movement!;
        const movementId = await recordStockMovement(client, {
          stock_material_id: line.stock_material_id,
          kind: 'MATERIAL_RECEIPT',
          material_receipt_line_id: line.id,
          effective_date: header.received_date,
          original_quantity: normalized.original_quantity,
          original_unit_id: normalized.original_unit_id,
          conversion_snapshot: normalized.conversion_snapshot,
          base_quantity: normalized.base_quantity,
          recorded_by: actorId,
        });
        await client.query('UPDATE material_receipt_lines SET stock_movement_id = $2 WHERE id = $1', [line.id, movementId]);
      }
      const facts = {
        receipt_number: number,
        received_date: header.received_date,
        source_party: sourceParty === null ? null : { id: sourceParty.id, name: sourceParty.name },
        source_type: sourceType === null ? null : { id: sourceType.id, name: sourceType.name },
        receipt_reference: header.receipt_reference,
        note: header.note,
        lines: lines.map((line) => ({
          line_id: line.id,
          position: line.position,
          stock_material: { id: line.stock_material_id, name: names.get(line.stock_material_id)! },
          quantity: line.quantity,
          unit: { id: line.unit_id, name: units.get(line.stock_material_id)!.find(({ unit_id }) => unit_id === line.unit_id)!.name },
          unit_price: line.unit_price,
          note: line.note,
        })),
      };
      await client.query(`INSERT INTO material_receipt_history (material_receipt_id, version, kind, facts, recorded_by) VALUES ($1, $2, 'CONFIRMED', $3, $4)`, [
        id,
        version,
        JSON.stringify(facts),
        actorId,
      ]);
      return { material_receipt_id: id, receipt_number: number, version };
    });
  }
}
