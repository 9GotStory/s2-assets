import pg from 'pg';
import { bangkokDate, isCalendarDate, normalizeText } from './assignment.service.ts';
import { normalizeQuantity } from './base-quantity.ts';
import { stockFiguresOf } from './current-stock.ts';
import { materialReceiptsInEffectOf, type InEffectMaterialReceipt } from './material-receipt-read.service.ts';
import { openingBalancesInEffectOf } from './opening-balance-read.service.ts';
import { openingBalanceState, type OpeningBalanceState } from './opening-balance-state.ts';
import { commitOnce } from './retryable-write.ts';
import { NotFoundError, StaleBeforeConflictError } from './service-errors.ts';
import { draftQuantityOf, QUANTITY_REFUSALS, uuidOf, uuidOrNull } from './stock-line-input.ts';
import { lockedStockMaterialsForStock, stockMaterialSummariesOf, stockMaterialUnitsOf } from './stock-material-read.service.ts';
import { recordStockMovement } from './stock-movements.ts';
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
 * when there is none, when its version is not `expectedVersion`, or when it is no longer a Draft, in that order.
 */
const lockedDraft = async (client: pg.PoolClient, id: string, expectedVersion: number): Promise<CurrentState> => {
  const res = await client.query(`SELECT version, ${openingBalanceState('opening_balances')} AS state FROM opening_balances WHERE id = $1 FOR UPDATE`, [id]);
  const current: CurrentState | undefined = res.rows[0];
  if (!current) {
    throw new NotFoundError('Opening Balance not found');
  }
  if (current.version !== expectedVersion) {
    throw new StaleBeforeConflictError('The Opening Balance changed since it was read', current, { version: expectedVersion });
  }
  if (current.state !== 'DRAFT') {
    throw new OpeningBalanceNotDraftError(current, { version: expectedVersion });
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
