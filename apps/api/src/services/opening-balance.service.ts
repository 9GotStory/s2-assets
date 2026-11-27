import * as crypto from 'node:crypto';
import pg from 'pg';
import { bangkokDate, isCalendarDate, normalizeText } from './assignment.service.ts';
import { normalizeQuantity } from './base-quantity.ts';
import { stockFiguresOf } from './current-stock.ts';
import { materialReceiptsInEffectOf, materialReceiptsInEffectOnOrBefore, type InEffectMaterialReceipt } from './material-receipt-read.service.ts';
import { balanceLineFactsOf, planBalanceCorrection, type BalanceCorrectionFacts } from './opening-balance-correction.ts';
import { openingBalancesInEffectOf } from './opening-balance-read.service.ts';
import { openingBalanceState, type OpeningBalanceState } from './opening-balance-state.ts';
import { commitOnce } from './retryable-write.ts';
import { NotFoundError, StaleBeforeConflictError } from './service-errors.ts';
import { stockOf, type RecordedStockLine } from './stock-line-correction.ts';
import { asStored, draftQuantityOf, QUANTITY_REFUSALS, uuidOf, uuidOrNull } from './stock-line-input.ts';
import { lockedStockMaterialsForStock, stockMaterialSummariesOf, stockMaterialUnitsOf } from './stock-material-read.service.ts';
import { recordStockMovement, reverseStockMovement, stockMovementsInEffectOf } from './stock-movements.ts';
import { ValidationError } from './validation-error.ts';

// #231 Q25, P7: an Opening Balance holds 0 to 50 lines; its source is at most 500 characters, its note at most 2000,
// and a line's note at most 500.
export const MAX_OPENING_BALANCE_LINES = 50;
export const OPENING_BALANCE_SOURCE_MAX_LENGTH = 500;
export const OPENING_BALANCE_NOTE_MAX_LENGTH = 2000;
export const OPENING_BALANCE_LINE_NOTE_MAX_LENGTH = 500;

export interface OpeningBalanceLineInput {
  stock_material_id: string;
  unit_id?: string | null;
  // A decimal string in the Unit, at most four decimal places (#175 P1).
  quantity?: string | null;
  note?: string | null;
}

// A Draft as saved, which may be incomplete (Q25; #233 start decision 1).
export interface OpeningBalanceDraftInput {
  as_of_date?: string | null;
  source?: string | null;
  note?: string | null;
  lines: OpeningBalanceLineInput[];
}

export interface ReplaceDraftInput extends OpeningBalanceDraftInput {
  expected_version: number;
}

export interface ExpectedVersionInput {
  expected_version: number;
}

// F010-T7 (#238): a line of an Opening Balance correction: a recorded line by its id, or a new one without (#231 P5).
export interface OpeningBalanceCorrectionLineInput {
  line_id?: string | null;
  stock_material_id: string;
  unit_id: string;
  quantity: string;
  note?: string | null;
  // คำนวณใหม่ด้วยอัตราแปลงปัจจุบัน (Q29).
  recalculate?: boolean;
}

// F010-T7 (#238): the whole Opening Balance as it should be: its header, every line not voided kept in `lines` or named
// in `voided_line_ids`, new lines, a reason and the version the request read (#231 P5; start comment 7184458771).
export interface OpeningBalanceCorrectionInput extends ExpectedVersionInput {
  as_of_date: string;
  source?: string | null;
  note?: string | null;
  lines: OpeningBalanceCorrectionLineInput[];
  voided_line_ids?: string[];
  reason: string;
}

// F010-T7 (#238): the void of a whole Opening Balance: a reason and the version the request read.
export interface OpeningBalanceVoidInput extends ExpectedVersionInput {
  reason: string;
}

// #231 P7: a correction's or a void's reason is at most 2000 characters.
export const OPENING_BALANCE_REASON_MAX_LENGTH = 2000;

// What a create or a replace answers: the Opening Balance and the version a later write expects.
export interface OpeningBalanceVersion {
  opening_balance_id: string;
  version: number;
}

// What a confirm answers, with the number it took: a bigint as a string of digits (P10).
export interface OpeningBalanceConfirmed extends OpeningBalanceVersion {
  opening_balance_number: string;
}

type CurrentState = { version: number; state: OpeningBalanceState };

/** A replace, a remove or a confirm of an Opening Balance already confirmed, at the version it has (Q20). */
export class OpeningBalanceNotDraftError extends Error {
  statusCode = 409;
  code = 'NOT_DRAFT';
  current_values: CurrentState;
  expected_values: { version: number };

  constructor(currentValues: CurrentState, expectedValues: { version: number }) {
    super('The Opening Balance is confirmed: only a Draft can be replaced, removed or confirmed');
    this.name = 'OpeningBalanceNotDraftError';
    this.current_values = currentValues;
    this.expected_values = expectedValues;
  }
}

// One reason a confirm is refused, named by its field: `as_of_date`, `source`, `lines`, or `lines[<i>].<field>`.
export interface ConfirmProblem {
  field: string;
  message: string;
  // For a Stock Material with a Stock Movement in effect from an Opening Balance line: that Opening Balance (story 40).
  in_effect_opening_balance?: { opening_balance_id: string; opening_balance_number: string };
  // Or, for one from a Receipt Line: the Material Receipt of the lowest Receipt Number that holds one (#234 start
  // decision 3).
  in_effect_material_receipt?: InEffectMaterialReceipt;
}

/** F010-T7 (#238): a correction or a void of an Opening Balance that is still a Draft, at the version it has. */
export class OpeningBalanceNotConfirmedError extends Error {
  statusCode = 409;
  code = 'NOT_CONFIRMED';
  current_values: CurrentState;
  expected_values: { version: number };

  constructor(currentValues: CurrentState, expectedValues: { version: number }) {
    super('The Opening Balance is a Draft: only a confirmed one can be corrected or voided');
    this.name = 'OpeningBalanceNotConfirmedError';
    this.current_values = currentValues;
    this.expected_values = expectedValues;
  }
}

/** F010-T7 (#238): a correction or a void of an Opening Balance voided as a whole, at the version it has. */
export class OpeningBalanceVoidedError extends Error {
  statusCode = 409;
  code = 'VOIDED';
  current_values: CurrentState;
  expected_values: { version: number };

  constructor(currentValues: CurrentState, expectedValues: { version: number }) {
    super('The Opening Balance is voided: it can be neither corrected nor voided again');
    this.name = 'OpeningBalanceVoidedError';
    this.current_values = currentValues;
    this.expected_values = expectedValues;
  }
}

/** F010-T7 (#238): a correction refused, with every failing rule and line named, as a confirm is (Q25). Nothing is written. */
export class OpeningBalanceNotCorrectableError extends Error {
  statusCode = 409;
  code = 'NOT_CORRECTABLE';
  problems: ConfirmProblem[];

  constructor(problems: ConfirmProblem[]) {
    super(`The Opening Balance cannot be corrected: ${problems.map(({ message }) => message).join('; ')}`);
    this.name = 'OpeningBalanceNotCorrectableError';
    this.problems = problems;
  }
}

/** A confirm refused, with every failing rule and line named (#231 Q25). Nothing is written. */
export class OpeningBalanceNotConfirmableError extends Error {
  statusCode = 409;
  code = 'NOT_CONFIRMABLE';
  problems: ConfirmProblem[];

  constructor(problems: ConfirmProblem[]) {
    super(`The Opening Balance cannot be confirmed: ${problems.map(({ message }) => message).join('; ')}`);
    this.name = 'OpeningBalanceNotConfirmableError';
    this.problems = problems;
  }
}

// A Draft's facts once validated, before any lock. The retry fingerprint covers these.
const normalizeDraft = (input: OpeningBalanceDraftInput) => {
  let asOfDate: string | null = null;
  if (input.as_of_date !== undefined && input.as_of_date !== null) {
    if (!isCalendarDate(input.as_of_date)) {
      throw new ValidationError('as_of_date must be a date (YYYY-MM-DD)');
    }
    asOfDate = input.as_of_date;
  }
  if (input.lines.length > MAX_OPENING_BALANCE_LINES) {
    throw new ValidationError(`lines must hold at most ${MAX_OPENING_BALANCE_LINES} lines`);
  }
  const positions = new Map<string, number>();
  const lines = input.lines.map((line, position) => {
    const field = `lines[${position}]`;
    // The route requires it as a string (opening-balance.routes.ts).
    const stockMaterialId = uuidOf(line.stock_material_id, `${field}.stock_material_id`);
    const earlier = positions.get(stockMaterialId);
    if (earlier !== undefined) {
      throw new ValidationError(`${field}.stock_material_id repeats the Stock Material of lines[${earlier}]`);
    }
    positions.set(stockMaterialId, position);
    return {
      stock_material_id: stockMaterialId,
      unit_id: uuidOrNull(line.unit_id, `${field}.unit_id`),
      quantity: line.quantity === undefined || line.quantity === null ? null : draftQuantityOf(line.quantity, `${field}.quantity`),
      note: normalizeText(line.note, `${field}.note`, OPENING_BALANCE_LINE_NOTE_MAX_LENGTH, ''),
    };
  });
  return {
    as_of_date: asOfDate,
    source: normalizeText(input.source, 'source', OPENING_BALANCE_SOURCE_MAX_LENGTH, ''),
    note: normalizeText(input.note, 'note', OPENING_BALANCE_NOTE_MAX_LENGTH, ''),
    lines,
  };
};

type DraftFacts = ReturnType<typeof normalizeDraft>;

// F010-T7 (#238): a reason, checked before any lock: nonblank, at most 2000 characters.
const reasonOf = (value: string): string => {
  const reason = normalizeText(value, 'reason', OPENING_BALANCE_REASON_MAX_LENGTH, '');
  if (reason === null) {
    throw new ValidationError('reason must not be blank');
  }
  return reason;
};

// F010-T7 (#238): a correction's facts once validated, before any lock, as a Receipt Correction's are (T6). The retry
// fingerprint covers these.
const normalizeCorrection = (input: OpeningBalanceCorrectionInput): BalanceCorrectionFacts => {
  const reason = reasonOf(input.reason);
  if (!isCalendarDate(input.as_of_date)) {
    throw new ValidationError('as_of_date must be a date (YYYY-MM-DD)');
  }
  const lineIds = new Map<string, number>();
  const materials = new Map<string, number>();
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
    // Each Stock Material once (Q13, story 42).
    const stockMaterialId = uuidOf(line.stock_material_id, `${field}.stock_material_id`);
    const earlier = materials.get(stockMaterialId);
    if (earlier !== undefined) {
      throw new ValidationError(`${field}.stock_material_id repeats the Stock Material of lines[${earlier}]`);
    }
    materials.set(stockMaterialId, index);
    return {
      line_id: lineId,
      stock_material_id: stockMaterialId,
      unit_id: uuidOf(line.unit_id, `${field}.unit_id`),
      quantity: asStored(draftQuantityOf(line.quantity, `${field}.quantity`)),
      note: normalizeText(line.note, `${field}.note`, OPENING_BALANCE_LINE_NOTE_MAX_LENGTH, ''),
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
    as_of_date: input.as_of_date,
    source: normalizeText(input.source, 'source', OPENING_BALANCE_SOURCE_MAX_LENGTH, ''),
    note: normalizeText(input.note, 'note', OPENING_BALANCE_NOTE_MAX_LENGTH, ''),
    lines,
    voided_line_ids: voidedLineIds,
    reason,
  };
};

// Refuses a Draft line naming no Stock Material, or a Unit its Stock Material does not have; an Inactive Unit waits
// for confirm, since it can be made active again first (#233 start decision 1).
const refuseUnknownChoices = async (client: pg.PoolClient, facts: DraftFacts): Promise<void> => {
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
    `INSERT INTO opening_balance_lines (opening_balance_id, position, stock_material_id, unit_id, quantity, note)
     SELECT $1, line.position - 1, line.stock_material_id, line.unit_id, line.quantity, line.note
     FROM unnest($2::uuid[], $3::uuid[], $4::numeric[], $5::text[]) WITH ORDINALITY AS line(stock_material_id, unit_id, quantity, note, position)`,
    [
      id,
      facts.lines.map(({ stock_material_id }) => stock_material_id),
      facts.lines.map(({ unit_id }) => unit_id),
      facts.lines.map(({ quantity }) => quantity),
      facts.lines.map(({ note }) => note),
    ]
  );
};

/**
 * Locks the Opening Balance `id` FOR UPDATE, so its replace, remove and confirm take turns (#231 P4), and refuses it
 * when there is none, when its version is not `expectedVersion`, or when it is no longer a Draft, in that order. The
 * state reads the lines too (F010-T7, #238): a statement that waited on the lock rereads only the locked row, so the
 * state is read in a statement of its own after it, as the lock of a correction does.
 */
const lockedDraft = async (client: pg.PoolClient, id: string, expectedVersion: number): Promise<CurrentState> => {
  const locked = await client.query('SELECT 1 FROM opening_balances WHERE id = $1 FOR UPDATE', [id]);
  if (locked.rowCount === 0) {
    throw new NotFoundError('Opening Balance not found');
  }
  const current: CurrentState = (await client.query(`SELECT version, ${openingBalanceState('opening_balances')} AS state FROM opening_balances WHERE id = $1`, [id])).rows[0];
  if (current.version !== expectedVersion) {
    throw new StaleBeforeConflictError('The Opening Balance changed since it was read', current, { version: expectedVersion });
  }
  if (current.state !== 'DRAFT') {
    throw new OpeningBalanceNotDraftError(current, { version: expectedVersion });
  }
  return current;
};

/**
 * F010-T7 (#238): locks the Opening Balance `id` FOR UPDATE, as `lockedDraft` does, so its corrections and its void take
 * turns (#231 P4), and refuses it when there is none, when its version is not `expectedVersion`, when it is still a
 * Draft, or when it is voided, in that order. The state reads the lines too, and a statement that waited on the lock
 * still sees them as they were when it began, so it is read in a statement of its own, after the lock.
 */
const lockedConfirmed = async (client: pg.PoolClient, id: string, expectedVersion: number): Promise<void> => {
  const locked = await client.query('SELECT 1 FROM opening_balances WHERE id = $1 FOR UPDATE', [id]);
  if (locked.rowCount === 0) {
    throw new NotFoundError('Opening Balance not found');
  }
  const current: CurrentState = (await client.query(`SELECT version, ${openingBalanceState('opening_balances')} AS state FROM opening_balances WHERE id = $1`, [id])).rows[0];
  if (current.version !== expectedVersion) {
    throw new StaleBeforeConflictError('The Opening Balance changed since it was read', current, { version: expectedVersion });
  }
  if (current.state === 'DRAFT') {
    throw new OpeningBalanceNotConfirmedError(current, { version: expectedVersion });
  }
  if (current.state === 'VOIDED') {
    throw new OpeningBalanceVoidedError(current, { version: expectedVersion });
  }
};

// F010-T7 (#238): a confirmed line, as a correction and a void read it.
const RECORDED_LINES = `SELECT id, position, stock_material_id, unit_id, trim_scale(quantity)::text AS quantity, note, is_voided, stock_movement_id
                        FROM opening_balance_lines WHERE opening_balance_id = $1`;

// A stored Draft line, as a confirm reads it.
interface StoredLine {
  id: string;
  position: number;
  stock_material_id: string;
  unit_id: string | null;
  quantity: string | null;
  note: string | null;
}

/**
 * F010-T2 (#233): the Opening Balance (ยอดตั้งต้น): its Draft, kept by any Supply Officer, and its confirm
 * (ยืนยันยอดตั้งต้น), which adds its Stock Movements (#231 MOB-01–MOB-04, Q13, Q20, Q25, Q28). The reads are in
 * opening-balance-read.service.ts.
 */
export class OpeningBalanceService {
  private readonly db: pg.Pool | any;
  private readonly clock: () => Date;

  constructor(options: { db: pg.Pool | any; clock?: () => Date }) {
    this.db = options.db;
    this.clock = options.clock ?? (() => new Date());
  }

  /** Saves a new Draft of `input` by `actorId`, at version 1. */
  async create(actorId: string, input: OpeningBalanceDraftInput, { retryToken }: { retryToken: string }): Promise<OpeningBalanceVersion> {
    const facts = normalizeDraft(input);
    return commitOnce(this.db, { actorId, operation: 'opening-balance:create', retryToken, payload: facts, explicitContinuation: false }, async (client) => {
      await refuseUnknownChoices(client, facts);
      const res = await client.query('INSERT INTO opening_balances (as_of_date, source, note, created_by) VALUES ($1, $2, $3, $4) RETURNING id, version', [
        facts.as_of_date,
        facts.source,
        facts.note,
        actorId,
      ]);
      const { id, version } = res.rows[0];
      await insertLines(client, id, facts);
      return { opening_balance_id: id, version };
    });
  }

  /**
   * Replaces the whole Draft `id` with `input` at the version the request read, and moves it to its next version, even
   * when nothing differs (#233 start decision 3). A Draft has no history (P1).
   */
  async replace(actorId: string, id: string, input: ReplaceDraftInput, { retryToken }: { retryToken: string }): Promise<OpeningBalanceVersion> {
    const facts = normalizeDraft(input);
    const payload = { opening_balance_id: id, expected_version: input.expected_version, ...facts };
    return commitOnce(this.db, { actorId, operation: 'opening-balance:replace', retryToken, payload, explicitContinuation: false }, async (client) => {
      await lockedDraft(client, id, input.expected_version);
      await refuseUnknownChoices(client, facts);
      await client.query('DELETE FROM opening_balance_lines WHERE opening_balance_id = $1', [id]);
      await insertLines(client, id, facts);
      const res = await client.query('UPDATE opening_balances SET as_of_date = $2, source = $3, note = $4, version = version + 1 WHERE id = $1 RETURNING version', [
        id,
        facts.as_of_date,
        facts.source,
        facts.note,
      ]);
      return { opening_balance_id: id, version: res.rows[0].version };
    });
  }

  /** Removes the Draft `id` with its lines for good, at the version the request read: it leaves no record (Q4). */
  async remove(actorId: string, id: string, input: ExpectedVersionInput, { retryToken }: { retryToken: string }): Promise<{ opening_balance_id: string }> {
    const payload = { opening_balance_id: id, expected_version: input.expected_version };
    return commitOnce(this.db, { actorId, operation: 'opening-balance:remove', retryToken, payload, explicitContinuation: false }, async (client) => {
      await lockedDraft(client, id, input.expected_version);
      await client.query('DELETE FROM opening_balance_lines WHERE opening_balance_id = $1', [id]);
      await client.query('DELETE FROM opening_balances WHERE id = $1', [id]);
      return { opening_balance_id: id };
    });
  }

  /**
   * Confirms the Draft `id` at the version the request read (ยืนยันยอดตั้งต้น): rechecks it all under the lock order
   * (P4), then, in one transaction, gives it the next number, adds one Stock Movement per line on its As-of Date, and
   * records the confirmed history entry with names as they are now (#175 P6).
   */
  async confirm(actorId: string, id: string, input: ExpectedVersionInput, { retryToken }: { retryToken: string }): Promise<OpeningBalanceConfirmed> {
    const payload = { opening_balance_id: id, expected_version: input.expected_version };
    return commitOnce(this.db, { actorId, operation: 'opening-balance:confirm', retryToken, payload, explicitContinuation: false }, async (client) => {
      // 1. The Opening Balance.
      await lockedDraft(client, id, input.expected_version);
      const header = (await client.query('SELECT as_of_date::text AS as_of_date, source, note FROM opening_balances WHERE id = $1', [id])).rows[0];
      const lines: StoredLine[] = (
        await client.query(
          `SELECT id, position, stock_material_id, unit_id, trim_scale(quantity)::text AS quantity, note
           FROM opening_balance_lines WHERE opening_balance_id = $1 ORDER BY position`,
          [id]
        )
      ).rows;
      // 2. Its Stock Materials, by id; 3. their Units' list entries, each read in a statement after the lock.
      const names = await lockedStockMaterialsForStock(
        client,
        lines.map(({ stock_material_id }) => stock_material_id)
      );
      const units = new Map(await Promise.all(lines.map(async ({ stock_material_id }) => [stock_material_id, await stockMaterialUnitsOf(client, stock_material_id, { locked: true })] as const)));
      const inEffect = await this.inEffectHolders(client, lines);

      const problems: ConfirmProblem[] = [];
      const today = bangkokDate(this.clock());
      if (header.as_of_date === null) {
        problems.push({ field: 'as_of_date', message: 'as_of_date is required' });
      } else if (header.as_of_date > today) {
        problems.push({ field: 'as_of_date', message: `as_of_date must not be after today (${today}, Asia/Bangkok)` });
      }
      if (header.source === null) {
        problems.push({ field: 'source', message: 'source is required' });
      }
      if (lines.length === 0) {
        problems.push({ field: 'lines', message: 'lines must hold at least one line' });
      }
      const movements = lines.map((line) => {
        const field = `lines[${line.position}]`;
        const holder = inEffect.get(line.stock_material_id);
        if (holder !== undefined) {
          const named = `${field}.stock_material_id names ${names.get(line.stock_material_id)!}, a Stock Material with a Stock Movement in effect`;
          problems.push(
            'opening_balance_id' in holder
              ? { field: `${field}.stock_material_id`, message: `${named}, from Opening Balance ${holder.opening_balance_number}`, in_effect_opening_balance: holder }
              : { field: `${field}.stock_material_id`, message: `${named}, from Material Receipt ${holder.receipt_number}`, in_effect_material_receipt: holder }
          );
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
        throw new OpeningBalanceNotConfirmableError(problems);
      }

      const confirmed = await client.query(
        `UPDATE opening_balances SET opening_balance_number = nextval('opening_balance_numbers'), confirmed_by = $2, confirmed_at = now(), version = version + 1
         WHERE id = $1 RETURNING opening_balance_number::text, version`,
        [id, actorId]
      );
      const { opening_balance_number: number, version } = confirmed.rows[0];
      for (const movement of movements) {
        const { line, normalized } = movement!;
        const movementId = await recordStockMovement(client, {
          stock_material_id: line.stock_material_id,
          kind: 'OPENING_BALANCE',
          opening_balance_line_id: line.id,
          effective_date: header.as_of_date,
          original_quantity: normalized.original_quantity,
          original_unit_id: normalized.original_unit_id,
          conversion_snapshot: normalized.conversion_snapshot,
          base_quantity: normalized.base_quantity,
          recorded_by: actorId,
        });
        await client.query('UPDATE opening_balance_lines SET stock_movement_id = $2 WHERE id = $1', [line.id, movementId]);
      }
      const facts = {
        opening_balance_number: number,
        as_of_date: header.as_of_date,
        source: header.source,
        note: header.note,
        lines: lines.map((line) => ({
          line_id: line.id,
          position: line.position,
          stock_material: { id: line.stock_material_id, name: names.get(line.stock_material_id)! },
          quantity: line.quantity,
          unit: { id: line.unit_id, name: units.get(line.stock_material_id)!.find(({ unit_id }) => unit_id === line.unit_id)!.name },
          note: line.note,
        })),
      };
      await client.query(`INSERT INTO opening_balance_history (opening_balance_id, version, kind, facts, recorded_by) VALUES ($1, $2, 'CONFIRMED', $3, $4)`, [
        id,
        version,
        JSON.stringify(facts),
        actorId,
      ]);
      return { opening_balance_id: id, opening_balance_number: number, version };
    });
  }

  /**
   * F010-T7 (#238): a correction (แก้ไขรายการที่บันทึกผิด) of the confirmed Opening Balance `id`: the whole Opening
   * Balance as it should be, with a reason, at the version the request read, the same way as a Receipt Correction (T6;
   * #231 Q20, P5). Under the lock order (P4) it adds, for each line whose stock effect changes, a Reversal of its Stock
   * Movement in effect and a new Stock Movement on the As-of Date as corrected, and for each line it voids only the
   * Reversal, each recorded by the corrector at the one moment of the correction (P9); then the history entry
   * "corrected". A correction that changes nothing is refused (story 36). What it does is worked out in
   * opening-balance-correction.ts.
   */
  async correct(actorId: string, id: string, input: OpeningBalanceCorrectionInput, { retryToken }: { retryToken: string }): Promise<OpeningBalanceVersion> {
    const facts = normalizeCorrection(input);
    const payload = { opening_balance_id: id, expected_version: input.expected_version, ...facts };
    return commitOnce(this.db, { actorId, operation: 'opening-balance:correct', retryToken, payload, explicitContinuation: false }, async (client) => {
      // 1. The Opening Balance, its header and lines.
      await lockedConfirmed(client, id, input.expected_version);
      const header = (
        await client.query('SELECT opening_balance_number::text AS opening_balance_number, as_of_date::text AS as_of_date, source, note FROM opening_balances WHERE id = $1', [id])
      ).rows[0];
      const recordedLines: RecordedStockLine[] = (await client.query(`${RECORDED_LINES} ORDER BY position`, [id])).rows;
      const byId = new Map(recordedLines.map((line) => [line.id, line]));
      // A recorded line not voided, named by `field`.
      const recordedLine = (lineId: string, field: string): RecordedStockLine => {
        const line = byId.get(lineId);
        if (line === undefined) {
          throw new ValidationError(`${field} must name a line of this Opening Balance`);
        }
        if (line.is_voided) {
          throw new ValidationError(`${field} names a line already voided`);
        }
        return line;
      };
      const recorded = facts.lines.map((line, index) => (line.line_id === null ? undefined : recordedLine(line.line_id, `lines[${index}].line_id`)));
      const voided = facts.voided_line_ids.map((lineId, index) => recordedLine(lineId, `voided_line_ids[${index}]`));
      const named = new Set<string | null>([...facts.lines.map(({ line_id: lineId }) => lineId), ...facts.voided_line_ids]);
      const missing = recordedLines.find((line) => !line.is_voided && !named.has(line.id));
      if (missing !== undefined) {
        throw new ValidationError(`lines must keep or void the line at position ${missing.position}`);
      }
      // #237 start decision 2, as T6: voiding the whole Opening Balance is its own write.
      if (facts.lines.length === 0) {
        throw new ValidationError('lines must keep at least one line not voided: void the whole Opening Balance instead');
      }
      const added = facts.lines.filter(({ line_id: lineId }) => lineId === null).length;
      if (recordedLines.length + added > MAX_OPENING_BALANCE_LINES) {
        throw new ValidationError(`lines must hold at most ${MAX_OPENING_BALANCE_LINES} lines, voided ones included`);
      }

      // 2. Every Stock Material its lines name before and after, by id; 3. their Units' list entries, each read in a
      // statement after the lock; then what holds a Stock Movement in effect of the Stock Materials it sends.
      const kept = recordedLines.filter(({ is_voided: isVoided }) => !isVoided);
      const materialIds = [...new Set([...kept, ...facts.lines].map(({ stock_material_id: materialId }) => materialId))];
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
      const sentIds = facts.lines.map(({ stock_material_id: materialId }) => materialId);
      const movements = await stockMovementsInEffectOf(
        client,
        kept.map(({ stock_movement_id: movementId }) => movementId!)
      );
      const plan = planBalanceCorrection(
        facts,
        {
          id,
          header,
          recordedLines,
          recorded,
          voided,
          nextPosition: recordedLines.length,
          names,
          units,
          movements,
          openingBalances: await openingBalancesInEffectOf(client, sentIds),
          receipts: await materialReceiptsInEffectOf(client, sentIds),
          receiptsOnOrBefore: await materialReceiptsInEffectOnOrBefore(client, sentIds, facts.as_of_date),
          today: bangkokDate(this.clock()),
        },
        Array.from({ length: added }, () => crypto.randomUUID())
      );
      if (plan.problems.length > 0) {
        throw new OpeningBalanceNotCorrectableError(plan.problems);
      }
      if (plan.history === null) {
        throw new ValidationError('This correction changes nothing');
      }

      const { version } = (
        await client.query('UPDATE opening_balances SET as_of_date = $2, source = $3, note = $4, version = version + 1 WHERE id = $1 RETURNING version', [
          id,
          facts.as_of_date,
          facts.source,
          facts.note,
        ])
      ).rows[0];
      // The Reversals, of each line whose stock effect changes and each line voided.
      const moved = plan.kept.filter(({ movement }) => movement !== null);
      for (const { stock_movement_id: movementId } of [...moved.map(({ recorded: line }) => line), ...plan.voided]) {
        await reverseStockMovement(client, movementId!, actorId);
      }
      await client.query('UPDATE opening_balance_lines SET stock_movement_id = NULL WHERE id = ANY($1::uuid[])', [moved.map(({ recorded: line }) => line.id)]);
      await client.query('UPDATE opening_balance_lines SET stock_movement_id = NULL, is_voided = true WHERE id = ANY($1::uuid[])', [plan.voided.map((line) => line.id)]);
      await client.query(
        `UPDATE opening_balance_lines l
         SET stock_material_id = kept.stock_material_id, unit_id = kept.unit_id, quantity = kept.quantity, note = kept.note
         FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::numeric[], $5::text[]) AS kept(id, stock_material_id, unit_id, quantity, note)
         WHERE l.id = kept.id`,
        [
          plan.kept.map(({ recorded: line }) => line.id),
          plan.kept.map(({ line }) => line.stock_material_id),
          plan.kept.map(({ line }) => line.unit_id),
          plan.kept.map(({ line }) => line.quantity),
          plan.kept.map(({ line }) => line.note),
        ]
      );
      await client.query(
        `INSERT INTO opening_balance_lines (id, opening_balance_id, position, stock_material_id, unit_id, quantity, note)
         SELECT line.id, $1, line.position, line.stock_material_id, line.unit_id, line.quantity, line.note
         FROM unnest($2::uuid[], $3::smallint[], $4::uuid[], $5::uuid[], $6::numeric[], $7::text[]) AS line(id, position, stock_material_id, unit_id, quantity, note)`,
        [
          id,
          plan.added.map((line) => line.id),
          plan.added.map(({ position }) => position),
          plan.added.map(({ line }) => line.stock_material_id),
          plan.added.map(({ line }) => line.unit_id),
          plan.added.map(({ line }) => line.quantity),
          plan.added.map(({ line }) => line.note),
        ]
      );
      // The new Stock Movements, on the As-of Date as corrected.
      for (const { lineId, stockMaterialId, movement } of [
        ...moved.map(({ recorded: line, line: sent, movement }) => ({ lineId: line.id, stockMaterialId: sent.stock_material_id, movement: movement! })),
        ...plan.added.map(({ id: lineId, line, movement }) => ({ lineId, stockMaterialId: line.stock_material_id, movement })),
      ]) {
        const movementId = await recordStockMovement(client, {
          stock_material_id: stockMaterialId,
          kind: 'OPENING_BALANCE',
          opening_balance_line_id: lineId,
          effective_date: facts.as_of_date,
          original_quantity: movement.original_quantity,
          original_unit_id: movement.original_unit_id,
          conversion_snapshot: movement.conversion_snapshot,
          base_quantity: movement.base_quantity,
          recorded_by: actorId,
        });
        await client.query('UPDATE opening_balance_lines SET stock_movement_id = $2 WHERE id = $1', [lineId, movementId]);
      }
      await client.query(`INSERT INTO opening_balance_history (opening_balance_id, version, kind, facts, reason, recorded_by) VALUES ($1, $2, 'CORRECTED', $3, $4, $5)`, [
        id,
        version,
        JSON.stringify(plan.history),
        facts.reason,
        actorId,
      ]);
      return { opening_balance_id: id, version };
    });
  }

  /**
   * F010-T7 (#238): voids the whole confirmed Opening Balance `id` (ยกเลิกรายการ), with a reason, at the version the
   * request read, as a Material Receipt is voided: a Reversal of each line's Stock Movement in effect, recorded by the
   * voider at one moment (P9), every line voided, and the history entry "voided" with the reason and each line as it is
   * voided. Each of its Stock Materials can then take a new Opening Balance while it has no other Stock Movement in
   * effect (story 43).
   */
  async void(actorId: string, id: string, input: OpeningBalanceVoidInput, { retryToken }: { retryToken: string }): Promise<OpeningBalanceVersion> {
    const reason = reasonOf(input.reason);
    const payload = { opening_balance_id: id, expected_version: input.expected_version, reason };
    return commitOnce(this.db, { actorId, operation: 'opening-balance:void', retryToken, payload, explicitContinuation: false }, async (client) => {
      // 1. The Opening Balance, its number and its lines in effect: a confirmed one has at least one.
      await lockedConfirmed(client, id, input.expected_version);
      const { opening_balance_number: number } = (await client.query('SELECT opening_balance_number::text AS opening_balance_number FROM opening_balances WHERE id = $1', [id])).rows[0];
      const lines: RecordedStockLine[] = (await client.query(`${RECORDED_LINES} AND NOT is_voided ORDER BY position`, [id])).rows;
      // 2. Their Stock Materials, by id; 3. their Units' list entries, each read in a statement after the lock.
      const materialIds = lines.map(({ stock_material_id: materialId }) => materialId);
      const names = await lockedStockMaterialsForStock(client, materialIds);
      const units = new Map(await Promise.all(materialIds.map(async (materialId) => [materialId, await stockMaterialUnitsOf(client, materialId, { locked: true })] as const)));
      const movements = await stockMovementsInEffectOf(
        client,
        lines.map(({ stock_movement_id: movementId }) => movementId!)
      );

      for (const { stock_movement_id: movementId } of lines) {
        await reverseStockMovement(client, movementId!, actorId);
      }
      await client.query('UPDATE opening_balance_lines SET stock_movement_id = NULL, is_voided = true WHERE opening_balance_id = $1 AND NOT is_voided', [id]);
      const { version } = (await client.query('UPDATE opening_balances SET version = version + 1 WHERE id = $1 RETURNING version', [id])).rows[0];
      const history = {
        opening_balance_number: number,
        lines: lines.map((line) => ({
          change: 'VOIDED',
          line_id: line.id,
          position: line.position,
          line: balanceLineFactsOf({ names, units }, line, stockOf(movements.get(line.stock_movement_id!)!)),
        })),
      };
      await client.query(`INSERT INTO opening_balance_history (opening_balance_id, version, kind, facts, reason, recorded_by) VALUES ($1, $2, 'VOIDED', $3, $4, $5)`, [
        id,
        version,
        JSON.stringify(history),
        reason,
        actorId,
      ]);
      return { opening_balance_id: id, version };
    });
  }

  /**
   * Of the Stock Materials of `lines`, those with a Stock Movement in effect (Q28), decided by the one SQL source alone,
   * each with what holds it: the Opening Balance whose line points at it, or else the Material Receipt (story 40; #234
   * start decision 3). Every Stock Movement in effect comes from one of the two in Feature 010.
   */
  private async inEffectHolders(
    client: pg.PoolClient,
    lines: StoredLine[]
  ): Promise<Map<string, NonNullable<ConfirmProblem['in_effect_opening_balance']> | InEffectMaterialReceipt>> {
    const res = await client.query(
      `SELECT s.id FROM unnest($1::uuid[]) AS s(id) CROSS JOIN LATERAL ${stockFiguresOf('s.id')} f WHERE f.has_stock_movement_in_effect`,
      [lines.map(({ stock_material_id }) => stock_material_id)]
    );
    const ids: string[] = res.rows.map(({ id }: { id: string }) => id);
    const openingBalances = await openingBalancesInEffectOf(client, ids);
    const receipts = await materialReceiptsInEffectOf(client, ids);
    return new Map(
      ids.map((id) => {
        const openingBalance = openingBalances.get(id);
        return [id, openingBalance === undefined ? receipts.get(id)! : { opening_balance_id: openingBalance.opening_balance_id, opening_balance_number: openingBalance.opening_balance_number }];
      })
    );
  }
}
