import { normalizeQuantity, type NormalizedQuantity } from './base-quantity.ts';
import { QUANTITY_REFUSALS } from './stock-line-input.ts';
import type { StockMaterialUnit } from './stock-material-read.service.ts';
import type { StockMovementInEffect } from './stock-movements.ts';

// F010-T7 (#238): what a correction does to the lines of a confirmed stock record, the Material Receipt (T6, #237) and
// the Opening Balance (T7) alike (#231 "An Opening Balance is corrected the same way"; Q18, Q29, P5): each line's new
// Stock Movement where its stock effect changes, the lines it adds and voids, the history's line entries, and the
// problems of the Units they take. The record's own rules (its date, its uniqueness, Q21, Q28) stay with the record's
// plan. It reads and writes nothing itself.

// A line of the record as the correction reads it under the lock.
export interface RecordedStockLine {
  id: string;
  position: number;
  stock_material_id: string;
  unit_id: string;
  quantity: string;
  note: string | null;
  is_voided: boolean;
  // Its Stock Movement in effect; none once voided.
  stock_movement_id: string | null;
}

// A line of the record as the correction sends it, once checked: a recorded line by its id, or a new one.
export interface CorrectedStockLine {
  line_id: string | null;
  stock_material_id: string;
  unit_id: string;
  // A decimal string written as PostgreSQL reads it back, so equal values compare equal.
  quantity: string;
  note: string | null;
  // คำนวณใหม่ด้วยอัตราแปลงปัจจุบัน (Q29).
  recalculate: boolean;
}

// One reason a correction is refused, named by its field.
export interface LineProblem {
  field: string;
  message: string;
}

// What the correction read under the lock order of its lines.
export interface StockLineReads<R extends RecordedStockLine> {
  // For each line the correction sends, its recorded line, or undefined for a new one.
  recorded: (R | undefined)[];
  // The recorded lines it voids, in the order the request names them.
  voided: R[];
  // The position the first new line takes.
  nextPosition: number;
  // Of every Stock Material its lines name before and after: its name and its Units.
  names: Map<string, string>;
  units: Map<string, StockMaterialUnit[]>;
  // The Stock Movement in effect of each recorded line it keeps or voids.
  movements: Map<string, StockMovementInEffect>;
}

// A recorded line the correction keeps, with what it sends for it, the Stock Movement it now takes if its stock effect
// changes, and whether its own facts change that effect: its Stock Material, Unit or quantity, or a recalculate that
// finds another factor, as opposed to a date alone (#238 start decision 2).
export interface KeptStockLine<R, S> {
  recorded: R;
  line: S;
  movement: NormalizedQuantity | null;
  ownChange: boolean;
}

export interface AddedStockLine<S> {
  id: string;
  position: number;
  line: S;
  movement: NormalizedQuantity;
}

export interface StockLinePlan<R, S> {
  problems: LineProblem[];
  kept: KeptStockLine<R, S>[];
  added: AddedStockLine<S>[];
  // The history entry's line entries: ADDED, CHANGED and VOIDED.
  entries: Record<string, unknown>[];
}

// The Conversion Factor and Base Quantity a line's history records beside its facts.
export interface LineStock {
  conversion_factor: string;
  base_quantity: string;
}

export const stockOf = (movement: StockMovementInEffect | NormalizedQuantity): LineStock => ({
  conversion_factor: movement.conversion_snapshot.conversion_factor,
  base_quantity: movement.base_quantity,
});

/**
 * The lines of a correction sending `lines`, read as `reads`: new lines take the ids `newLineIds`, and `dateChanged` says
 * whether the record's date moves every Stock Movement in effect. A line's stock effect changes with its Stock Material,
 * Unit or quantity, the date, or a recalculate that finds another Conversion Factor (#237 start decision 3). A quantity
 * or date fix keeps the line's Conversion Snapshot, whatever its Unit is now (Q29; #237 start decision 4); a Stock
 * Material or Unit change, a recalculate and a new line take today's factor of an active Unit. `factsOf` gives a line's
 * facts as the history records them, with names as they are now (#175 P6).
 */
export function planStockLines<R extends RecordedStockLine, S extends CorrectedStockLine>(
  lines: S[],
  reads: StockLineReads<R>,
  dateChanged: boolean,
  newLineIds: string[],
  factsOf: (line: R | S, stock: LineStock) => Record<string, unknown>
): StockLinePlan<R, S> {
  const problems: LineProblem[] = [];

  // Today's factor of an active Unit, or the problems that refuse it.
  const atTodaysFactor = (field: string, line: S): NormalizedQuantity | null => {
    const units = reads.units.get(line.stock_material_id)!;
    if (units.some(({ unit_id, is_active }) => unit_id === line.unit_id && !is_active)) {
      problems.push({ field: `${field}.unit_id`, message: `${field}.unit_id names a Unit that is not active on its Stock Material` });
    }
    return normalized(field, units, line);
  };
  const normalized = (field: string, units: readonly StockMaterialUnit[], line: S): NormalizedQuantity | null => {
    const result = normalizeQuantity(units, line.unit_id, line.quantity);
    if (!result.ok) {
      problems.push({ field: `${field}.quantity`, message: `${field}.quantity ${QUANTITY_REFUSALS[result.reason]}` });
      return null;
    }
    return result;
  };

  const kept: KeptStockLine<R, S>[] = [];
  const added: AddedStockLine<S>[] = [];
  const entries: Record<string, unknown>[] = [];
  lines.forEach((line, index) => {
    const field = `lines[${index}]`;
    const recorded = reads.recorded[index];
    if (recorded === undefined) {
      const movement = atTodaysFactor(field, line);
      if (movement !== null) {
        const position = reads.nextPosition + added.length;
        added.push({ id: newLineIds[added.length], position, line, movement });
        entries.push({ change: 'ADDED', line_id: newLineIds[added.length - 1], position, line: factsOf(line, stockOf(movement)) });
      }
      return;
    }
    const inEffect = reads.movements.get(recorded.stock_movement_id!)!;
    const pairChanged = line.stock_material_id !== recorded.stock_material_id || line.unit_id !== recorded.unit_id;
    const quantityChanged = line.quantity !== recorded.quantity;
    let movement: NormalizedQuantity | null = null;
    let ownChange = pairChanged || quantityChanged;
    if (pairChanged || line.recalculate) {
      const atToday = atTodaysFactor(field, line);
      // A recalculate that finds the factor recorded then changes nothing by itself (#237 start decision 3). A refused
      // one leaves `movement` null, its problems named.
      ownChange ||= atToday?.conversion_snapshot.conversion_factor !== inEffect.conversion_snapshot.conversion_factor;
      if (ownChange || dateChanged) {
        movement = atToday;
      }
    } else if (quantityChanged || dateChanged) {
      // The Conversion Snapshot recorded then, whatever the Unit is now (Q29; #237 start decision 4).
      const units = reads.units.get(line.stock_material_id)!.map((unit) =>
        unit.unit_id === line.unit_id ? { ...unit, conversion_factor: inEffect.conversion_snapshot.conversion_factor } : unit
      );
      movement = normalized(field, units, line);
    }
    kept.push({ recorded, line, movement, ownChange });
    const before = factsOf(recorded, stockOf(inEffect));
    const after = factsOf(line, stockOf(movement ?? inEffect));
    // A line that moves records its Conversion Factor and Base Quantity before and after, an unchanged one included
    // (#237 start reading 7163337923; review decision 1, 7180557100).
    const changes = Object.keys(before)
      .filter((key) => (movement !== null && (key === 'conversion_factor' || key === 'base_quantity')) || JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .map((key) => ({ field: key, before: before[key], after: after[key] }));
    if (changes.length > 0) {
      entries.push({ change: 'CHANGED', line_id: recorded.id, position: recorded.position, changes });
    }
  });
  for (const recorded of reads.voided) {
    entries.push({ change: 'VOIDED', line_id: recorded.id, position: recorded.position, line: factsOf(recorded, stockOf(reads.movements.get(recorded.stock_movement_id!)!)) });
  }
  return { problems, kept, added, entries };
}
