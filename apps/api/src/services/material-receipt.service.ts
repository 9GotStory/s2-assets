import * as crypto from 'node:crypto';
import pg from 'pg';
import { bangkokDate, isCalendarDate, normalizeText } from './assignment.service.ts';
import { normalizeQuantity } from './base-quantity.ts';
import { catalogListHolds, lockedCatalogListEntry } from './catalog-list.service.ts';
import { CATALOG_LISTS } from './catalog-list-entries.ts';
import { parseDecimal } from './exact-decimal.ts';
import { lineFactsOf, planCorrection, type CorrectionFacts, type ListEntryRead, type RecordedLine } from './material-receipt-correction.ts';
import { stockOf } from './stock-line-correction.ts';
import { materialReceiptState, type MaterialReceiptState } from './material-receipt-state.ts';
import { openingBalancesInEffectOf, type InEffectOpeningBalance } from './opening-balance-read.service.ts';
import { commitOnce } from './retryable-write.ts';
import { NotFoundError, StaleBeforeConflictError } from './service-errors.ts';
import { asStored, draftQuantityOf, pairKey, QUANTITY_REFUSALS, uuidOf, uuidOrNull } from './stock-line-input.ts';
import { lockedStockMaterialsForStock, stockMaterialSummariesOf, stockMaterialUnitsOf } from './stock-material-read.service.ts';
import { recordStockMovement, reverseStockMovement, stockMovementsInEffectOf } from './stock-movements.ts';
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

// F010-T6 (#237): a line of a Receipt Correction: a recorded line by its id, or a new one without (#231 P5).
export interface ReceiptCorrectionLineInput {
  line_id?: string | null;
  stock_material_id: string;
  unit_id: string;
  quantity: string;
  unit_price?: string | null;
  note?: string | null;
  // คำนวณใหม่ด้วยอัตราแปลงปัจจุบัน (Q29).
  recalculate?: boolean;
}

// F010-T6 (#237): the whole Material Receipt as it should be: its header, every line not voided kept in `lines` or
// named in `voided_line_ids`, new lines, a reason and the version the request read (#231 P5).
export interface MaterialReceiptCorrectionInput extends ExpectedVersionInput {
  received_date: string;
  source_party_id?: string | null;
  source_type_id?: string | null;
  receipt_reference?: string | null;
  note?: string | null;
  lines: ReceiptCorrectionLineInput[];
  voided_line_ids?: string[];
  reason: string;
}

// #231 P7: a correction's reason is at most 2000 characters.
export const RECEIPT_CORRECTION_REASON_MAX_LENGTH = 2000;

// F010-T7 (#238): the void of a whole Material Receipt: a reason and the version the request read (#231 P5).
export interface MaterialReceiptVoidInput extends ExpectedVersionInput {
  reason: string;
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

/** F010-T6 (#237): a correction (F010-T7, #238: or a void) of a Material Receipt that is still a Draft, at the version it has (start comment 7163337923). */
export class MaterialReceiptNotReceivedError extends Error {
  statusCode = 409;
  code = 'NOT_RECEIVED';
  current_values: CurrentState;
  expected_values: { version: number };

  constructor(currentValues: CurrentState, expectedValues: { version: number }) {
    super('The Material Receipt is a Draft: only a Received one can be corrected or voided');
    this.name = 'MaterialReceiptNotReceivedError';
    this.current_values = currentValues;
    this.expected_values = expectedValues;
  }
}

/**
 * F010-T7 (#238): a correction or a void of a Material Receipt voided as a whole, at the version it has: it takes neither
 * again (start comment 7184458771).
 */
export class MaterialReceiptVoidedError extends Error {
  statusCode = 409;
  code = 'VOIDED';
  current_values: CurrentState;
  expected_values: { version: number };

  constructor(currentValues: CurrentState, expectedValues: { version: number }) {
    super('The Material Receipt is voided: it can be neither corrected nor voided again');
    this.name = 'MaterialReceiptVoidedError';
    this.current_values = currentValues;
    this.expected_values = expectedValues;
  }
}

/** F010-T6 (#237): a correction refused, with every failing rule and line named, as a confirm is (Q25). Nothing is written. */
export class MaterialReceiptNotCorrectableError extends Error {
  statusCode = 409;
  code = 'NOT_CORRECTABLE';
  problems: ReceiptConfirmProblem[];

  constructor(problems: ReceiptConfirmProblem[]) {
    super(`The Material Receipt cannot be corrected: ${problems.map(({ message }) => message).join('; ')}`);
    this.name = 'MaterialReceiptNotCorrectableError';
    this.problems = problems;
  }
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
      const pair = pairKey({ stock_material_id: stockMaterialId, unit_id: unitId });
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

// F010-T6 (#237): a correction's facts once validated, before any lock. The retry fingerprint covers these.
const normalizeCorrection = (input: MaterialReceiptCorrectionInput): CorrectionFacts => {
  const reason = normalizeText(input.reason, 'reason', RECEIPT_CORRECTION_REASON_MAX_LENGTH, '');
  if (reason === null) {
    throw new ValidationError('reason must not be blank');
  }
  if (!isCalendarDate(input.received_date)) {
    throw new ValidationError('received_date must be a date (YYYY-MM-DD)');
  }
  const lineIds = new Map<string, number>();
  const pairs = new Map<string, number>();
  const lines = input.lines.map((line, index) => {
    const field = `lines[${index}]`;
    const lineId = uuidOrNull(line.line_id, `${field}.line_id`);
    if (lineId !== null) {
      const earlier = lineIds.get(lineId);
      if (earlier !== undefined) {
        throw new ValidationError(`${field}.line_id repeats lines[${earlier}]`);
      }
      lineIds.set(lineId, index);
    }
    const stockMaterialId = uuidOf(line.stock_material_id, `${field}.stock_material_id`);
    const unitId = uuidOf(line.unit_id, `${field}.unit_id`);
    // A Stock Material twice only in different Units (Q9).
    const pair = pairKey({ stock_material_id: stockMaterialId, unit_id: unitId });
    const earlier = pairs.get(pair);
    if (earlier !== undefined) {
      throw new ValidationError(`${field}.unit_id repeats the Stock Material and Unit of lines[${earlier}]`);
    }
    pairs.set(pair, index);
    return {
      line_id: lineId,
      stock_material_id: stockMaterialId,
      unit_id: unitId,
      quantity: asStored(draftQuantityOf(line.quantity, `${field}.quantity`)),
      unit_price: line.unit_price === undefined || line.unit_price === null ? null : asStored(unitPriceOf(line.unit_price, `${field}.unit_price`)),
      note: normalizeText(line.note, `${field}.note`, RECEIPT_LINE_NOTE_MAX_LENGTH, ''),
      recalculate: line.recalculate === true,
    };
  });
  const voidedIds = new Map<string, number>();
  const voidedLineIds = (input.voided_line_ids ?? []).map((value, index) => {
    const field = `voided_line_ids[${index}]`;
    const lineId = uuidOf(value, field);
    const kept = lineIds.get(lineId);
    if (kept !== undefined) {
      throw new ValidationError(`${field} names lines[${kept}], which the correction keeps`);
    }
    const earlier = voidedIds.get(lineId);
    if (earlier !== undefined) {
      throw new ValidationError(`${field} repeats voided_line_ids[${earlier}]`);
    }
    voidedIds.set(lineId, index);
    return lineId;
  });
  return {
    received_date: input.received_date,
    source_party_id: uuidOrNull(input.source_party_id, 'source_party_id'),
    source_type_id: uuidOrNull(input.source_type_id, 'source_type_id'),
    receipt_reference: normalizeText(input.receipt_reference, 'receipt_reference', RECEIPT_REFERENCE_MAX_LENGTH, ''),
    note: normalizeText(input.note, 'note', MATERIAL_RECEIPT_NOTE_MAX_LENGTH, ''),
    lines,
    voided_line_ids: voidedLineIds,
    reason,
  };
};

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
 * when there is none, when its version is not `expectedVersion`, or when it is no longer a Draft, in that order. The
 * state reads the lines too (F010-T7, #238): a statement that waited on the lock rereads only the locked row, so the
 * state is read in a statement of its own after it, as the lock of a correction does.
 */
const lockedDraft = async (client: pg.PoolClient, id: string, expectedVersion: number): Promise<CurrentState> => {
  const locked = await client.query('SELECT 1 FROM material_receipts WHERE id = $1 FOR UPDATE', [id]);
  if (locked.rowCount === 0) {
    throw new NotFoundError('Material Receipt not found');
  }
  const current: CurrentState = (await client.query(`SELECT version, ${materialReceiptState('material_receipts')} AS state FROM material_receipts WHERE id = $1`, [id])).rows[0];
  if (current.version !== expectedVersion) {
    throw new StaleBeforeConflictError('The Material Receipt changed since it was read', current, { version: expectedVersion });
  }
  if (current.state !== 'DRAFT') {
    throw new MaterialReceiptNotDraftError(current, { version: expectedVersion });
  }
  return current;
};

/**
 * F010-T6 (#237): locks the Material Receipt `id` FOR UPDATE, as `lockedDraft` does, so its corrections and its void
 * take turns (#231 P4), and refuses it when there is none, when its version is not `expectedVersion`, when it is still a
 * Draft, or (F010-T7, #238) when it is voided, in that order.
 */
const lockedReceived = async (client: pg.PoolClient, id: string, expectedVersion: number): Promise<void> => {
  const locked = await client.query('SELECT 1 FROM material_receipts WHERE id = $1 FOR UPDATE', [id]);
  if (locked.rowCount === 0) {
    throw new NotFoundError('Material Receipt not found');
  }
  // The state reads the lines too. A statement that waited on the lock rereads only the locked row and still sees the
  // lines as they were when it began, so the state is read in a statement of its own, after the lock (F010-T7, #238).
  const current: CurrentState = (await client.query(`SELECT version, ${materialReceiptState('material_receipts')} AS state FROM material_receipts WHERE id = $1`, [id])).rows[0];
  if (current.version !== expectedVersion) {
    throw new StaleBeforeConflictError('The Material Receipt changed since it was read', current, { version: expectedVersion });
  }
  if (current.state === 'DRAFT') {
    throw new MaterialReceiptNotReceivedError(current, { version: expectedVersion });
  }
  if (current.state === 'VOIDED') {
    throw new MaterialReceiptVoidedError(current, { version: expectedVersion });
  }
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

  /**
   * F010-T6 (#237): a Receipt Correction (แก้ไขรายการที่บันทึกผิด) of the Received Material Receipt `id`: the whole
   * Material Receipt as it should be, with a reason, at the version the request read (#231 P5). Under the lock order
   * (P4) it adds, for each line whose stock effect changes, a Reversal of its Stock Movement in effect and a new Stock
   * Movement, and for each line it voids only the Reversal, each recorded by the corrector at the one moment of the
   * correction (P9); then the history entry "corrected". Paperwork fixes move no stock (MRC-08, MRC-11); a correction
   * that changes nothing is refused (story 36). What it does is worked out in material-receipt-correction.ts.
   */
  async correct(actorId: string, id: string, input: MaterialReceiptCorrectionInput, { retryToken }: { retryToken: string }): Promise<MaterialReceiptVersion> {
    const facts = normalizeCorrection(input);
    const payload = { material_receipt_id: id, expected_version: input.expected_version, ...facts };
    return commitOnce(this.db, { actorId, operation: 'material-receipt:correct', retryToken, payload, explicitContinuation: false }, async (client) => {
      // 1. The Material Receipt, its header and lines.
      await lockedReceived(client, id, input.expected_version);
      const header = (
        await client.query(
          `SELECT receipt_number::text AS receipt_number, received_date::text AS received_date, source_party_id, source_type_id, receipt_reference, note
           FROM material_receipts WHERE id = $1`,
          [id]
        )
      ).rows[0];
      const recordedLines: RecordedLine[] = (
        await client.query(
          `SELECT id, position, stock_material_id, unit_id, trim_scale(quantity)::text AS quantity, trim_scale(unit_price)::text AS unit_price, note,
                  is_voided, stock_movement_id
           FROM material_receipt_lines WHERE material_receipt_id = $1 ORDER BY position`,
          [id]
        )
      ).rows;
      const byId = new Map(recordedLines.map((line) => [line.id, line]));
      // A recorded line not voided, named by `field`.
      const recordedLine = (lineId: string, field: string): RecordedLine => {
        const line = byId.get(lineId);
        if (line === undefined) {
          throw new ValidationError(`${field} must name a Receipt Line of this Material Receipt`);
        }
        if (line.is_voided) {
          throw new ValidationError(`${field} names a Receipt Line already voided`);
        }
        return line;
      };
      const recorded = facts.lines.map((line, index) => (line.line_id === null ? undefined : recordedLine(line.line_id, `lines[${index}].line_id`)));
      const voided = facts.voided_line_ids.map((lineId, index) => recordedLine(lineId, `voided_line_ids[${index}]`));
      const named = new Set<string | null>([...facts.lines.map(({ line_id: lineId }) => lineId), ...facts.voided_line_ids]);
      const missing = recordedLines.find((line) => !line.is_voided && !named.has(line.id));
      if (missing !== undefined) {
        throw new ValidationError(`lines must keep or void the Receipt Line at position ${missing.position}`);
      }
      // Start decision 2: voiding the whole Material Receipt is its own write.
      if (facts.lines.length === 0) {
        throw new ValidationError('lines must keep at least one line not voided: void the whole Material Receipt instead');
      }
      const added = facts.lines.filter(({ line_id: lineId }) => lineId === null).length;
      if (recordedLines.length + added > MAX_RECEIPT_LINES) {
        throw new ValidationError(`lines must hold at most ${MAX_RECEIPT_LINES} lines, voided ones included`);
      }

      // 2. Every Stock Material its lines name before and after, by id; 3. their Units' list entries, then the Source
      // Party and Source Type it changes, each read in a statement after the lock.
      const materialIds = [...new Set([...recordedLines.filter(({ is_voided: isVoided }) => !isVoided), ...facts.lines].map(({ stock_material_id: materialId }) => materialId))];
      const names = await lockedStockMaterialsForStock(client, materialIds);
      facts.lines.forEach((line, index) => {
        if (!names.has(line.stock_material_id)) {
          throw new ValidationError(`lines[${index}].stock_material_id must name a Stock Material`);
        }
      });
      const units = new Map(await Promise.all(materialIds.map(async (materialId) => [materialId, await stockMaterialUnitsOf(client, materialId, { locked: true })] as const)));
      facts.lines.forEach((line, index) => {
        if (!units.get(line.stock_material_id)!.some(({ unit_id: unitId }) => unitId === line.unit_id)) {
          throw new ValidationError(`lines[${index}].unit_id must name a Unit of its Stock Material`);
        }
      });
      const listRead = async (field: 'source_party_id' | 'source_type_id', kind: 'source-party' | 'source-type') => {
        if (facts[field] === header[field]) {
          return null;
        }
        const entryOf = async (entryId: string | null): Promise<ListEntryRead | null> => (entryId === null ? null : lockedCatalogListEntry(client, kind, entryId));
        const after = await entryOf(facts[field]);
        if (facts[field] !== null && after === null) {
          throw new ValidationError(`${field} must name a ${CATALOG_LISTS[kind].concept}`);
        }
        return { before: await entryOf(header[field]), after };
      };
      const sourceParty = await listRead('source_party_id', 'source-party');
      const sourceType = await listRead('source_type_id', 'source-type');
      const openingBalances = await openingBalancesInEffectOf(client, materialIds);
      const movements = await stockMovementsInEffectOf(
        client,
        recordedLines.filter(({ is_voided: isVoided }) => !isVoided).map(({ stock_movement_id: movementId }) => movementId!)
      );

      const plan = planCorrection(
        facts,
        { header, recorded, voided, voidedBefore: recordedLines.filter(({ is_voided: isVoided }) => isVoided), nextPosition: recordedLines.length, names, units, openingBalances, movements, sourceParty, sourceType, today: bangkokDate(this.clock()) },
        Array.from({ length: added }, () => crypto.randomUUID())
      );
      if (plan.problems.length > 0) {
        throw new MaterialReceiptNotCorrectableError(plan.problems);
      }
      if (plan.history === null) {
        throw new ValidationError('This Receipt Correction changes nothing');
      }

      const updated = await client.query(
        `UPDATE material_receipts SET received_date = $2, source_party_id = $3, source_type_id = $4, receipt_reference = $5, note = $6, version = version + 1
         WHERE id = $1 RETURNING version`,
        [id, facts.received_date, facts.source_party_id, facts.source_type_id, facts.receipt_reference, facts.note]
      );
      const { version } = updated.rows[0];
      // The Reversals, of each line whose stock effect changes and each line voided.
      const moved = plan.kept.filter(({ movement }) => movement !== null);
      for (const { stock_movement_id: movementId } of [...moved.map(({ recorded: line }) => line), ...plan.voided]) {
        await reverseStockMovement(client, movementId!, actorId);
      }
      // A line that moves lets go of its Stock Movement and its Unit first, so that two lines may trade Units (Q9).
      await client.query('UPDATE material_receipt_lines SET stock_movement_id = NULL, unit_id = NULL WHERE id = ANY($1::uuid[])', [moved.map(({ recorded: line }) => line.id)]);
      await client.query('UPDATE material_receipt_lines SET stock_movement_id = NULL, is_voided = true WHERE id = ANY($1::uuid[])', [plan.voided.map((line) => line.id)]);
      await client.query(
        `UPDATE material_receipt_lines l
         SET stock_material_id = kept.stock_material_id, unit_id = kept.unit_id, quantity = kept.quantity, unit_price = kept.unit_price, note = kept.note
         FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::numeric[], $5::numeric[], $6::text[]) AS kept(id, stock_material_id, unit_id, quantity, unit_price, note)
         WHERE l.id = kept.id`,
        [
          plan.kept.map(({ recorded: line }) => line.id),
          plan.kept.map(({ line }) => line.stock_material_id),
          plan.kept.map(({ line }) => line.unit_id),
          plan.kept.map(({ line }) => line.quantity),
          plan.kept.map(({ line }) => line.unit_price),
          plan.kept.map(({ line }) => line.note),
        ]
      );
      await client.query(
        `INSERT INTO material_receipt_lines (id, material_receipt_id, position, stock_material_id, unit_id, quantity, unit_price, note)
         SELECT line.id, $1, line.position, line.stock_material_id, line.unit_id, line.quantity, line.unit_price, line.note
         FROM unnest($2::uuid[], $3::smallint[], $4::uuid[], $5::uuid[], $6::numeric[], $7::numeric[], $8::text[]) AS line(id, position, stock_material_id, unit_id, quantity, unit_price, note)`,
        [
          id,
          plan.added.map((line) => line.id),
          plan.added.map(({ position }) => position),
          plan.added.map(({ line }) => line.stock_material_id),
          plan.added.map(({ line }) => line.unit_id),
          plan.added.map(({ line }) => line.quantity),
          plan.added.map(({ line }) => line.unit_price),
          plan.added.map(({ line }) => line.note),
        ]
      );
      // The new Stock Movements, on the Received Date as corrected.
      for (const { lineId, stockMaterialId, movement } of [
        ...moved.map(({ recorded: line, line: sent, movement }) => ({ lineId: line.id, stockMaterialId: sent.stock_material_id, movement: movement! })),
        ...plan.added.map(({ id: lineId, line, movement }) => ({ lineId, stockMaterialId: line.stock_material_id, movement })),
      ]) {
        const movementId = await recordStockMovement(client, {
          stock_material_id: stockMaterialId,
          kind: 'MATERIAL_RECEIPT',
          material_receipt_line_id: lineId,
          effective_date: facts.received_date,
          original_quantity: movement.original_quantity,
          original_unit_id: movement.original_unit_id,
          conversion_snapshot: movement.conversion_snapshot,
          base_quantity: movement.base_quantity,
          recorded_by: actorId,
        });
        await client.query('UPDATE material_receipt_lines SET stock_movement_id = $2 WHERE id = $1', [lineId, movementId]);
      }
      await client.query(`INSERT INTO material_receipt_history (material_receipt_id, version, kind, facts, reason, recorded_by) VALUES ($1, $2, 'CORRECTED', $3, $4, $5)`, [
        id,
        version,
        JSON.stringify(plan.history),
        facts.reason,
        actorId,
      ]);
      return { material_receipt_id: id, version };
    });
  }

  /**
   * F010-T7 (#238): voids the whole Received Material Receipt `id` that never happened (ยกเลิกรายการ), with a reason, at
   * the version the request read (#231 Q18, P5). Under the lock order (P4) it adds a Reversal of each line's Stock
   * Movement in effect, recorded by the voider at the one moment of the void (P9), marks every line voided, and records
   * the history entry "voided" with the reason and each line as it is voided, names as they are now (#175 P6). It then
   * reads ยกเลิกแล้ว and takes no correction or void again.
   */
  async void(actorId: string, id: string, input: MaterialReceiptVoidInput, { retryToken }: { retryToken: string }): Promise<MaterialReceiptVersion> {
    const reason = normalizeText(input.reason, 'reason', RECEIPT_CORRECTION_REASON_MAX_LENGTH, '');
    if (reason === null) {
      throw new ValidationError('reason must not be blank');
    }
    const payload = { material_receipt_id: id, expected_version: input.expected_version, reason };
    return commitOnce(this.db, { actorId, operation: 'material-receipt:void', retryToken, payload, explicitContinuation: false }, async (client) => {
      // 1. The Material Receipt, its number and its lines in effect: a Received one has at least one.
      await lockedReceived(client, id, input.expected_version);
      const { receipt_number: receiptNumber } = (await client.query('SELECT receipt_number::text AS receipt_number FROM material_receipts WHERE id = $1', [id])).rows[0];
      const lines: RecordedLine[] = (
        await client.query(
          `SELECT id, position, stock_material_id, unit_id, trim_scale(quantity)::text AS quantity, trim_scale(unit_price)::text AS unit_price, note,
                  is_voided, stock_movement_id
           FROM material_receipt_lines WHERE material_receipt_id = $1 AND NOT is_voided ORDER BY position`,
          [id]
        )
      ).rows;
      // 2. Their Stock Materials, by id; 3. their Units' list entries, each read in a statement after the lock.
      const materialIds = [...new Set(lines.map(({ stock_material_id: materialId }) => materialId))];
      const names = await lockedStockMaterialsForStock(client, materialIds);
      const units = new Map(await Promise.all(materialIds.map(async (materialId) => [materialId, await stockMaterialUnitsOf(client, materialId, { locked: true })] as const)));
      const movements = await stockMovementsInEffectOf(
        client,
        lines.map(({ stock_movement_id: movementId }) => movementId!)
      );

      for (const { stock_movement_id: movementId } of lines) {
        await reverseStockMovement(client, movementId!, actorId);
      }
      await client.query('UPDATE material_receipt_lines SET stock_movement_id = NULL, is_voided = true WHERE material_receipt_id = $1 AND NOT is_voided', [id]);
      const { version } = (await client.query('UPDATE material_receipts SET version = version + 1 WHERE id = $1 RETURNING version', [id])).rows[0];
      const history = {
        receipt_number: receiptNumber,
        lines: lines.map((line) => ({
          change: 'VOIDED',
          line_id: line.id,
          position: line.position,
          line: lineFactsOf({ names, units }, line, stockOf(movements.get(line.stock_movement_id!)!)),
        })),
      };
      await client.query(`INSERT INTO material_receipt_history (material_receipt_id, version, kind, facts, reason, recorded_by) VALUES ($1, $2, 'VOIDED', $3, $4, $5)`, [
        id,
        version,
        JSON.stringify(history),
        reason,
        actorId,
      ]);
      return { material_receipt_id: id, version };
    });
  }
}
