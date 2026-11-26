import { normalizeQuantity, type NormalizedQuantity } from './base-quantity.ts';
import type { ReceiptConfirmProblem } from './material-receipt.service.ts';
import type { InEffectOpeningBalance } from './opening-balance-read.service.ts';
import { pairKey, QUANTITY_REFUSALS } from './stock-line-input.ts';
import type { StockMaterialUnit } from './stock-material-read.service.ts';
import type { StockMovementInEffect } from './stock-movements.ts';

// F010-T6 (#237): what a Receipt Correction (แก้ไขรายการที่บันทึกผิด) does, worked out from the Material Receipt as the
// request sends it and its facts as read under the lock order (#231 P4, P5): the problems that refuse it, each line's
// new Stock Movement where its stock effect changes, the lines it voids and adds, and the history entry "corrected". It
// reads and writes nothing itself; MaterialReceiptService.correct reads its facts and writes what it answers (#231
// Q18, Q29, P9; start comment 7163337923).

// A Receipt Line of a Received Material Receipt, as the correction reads it under the lock.
export interface RecordedLine {
  id: string;
  position: number;
  stock_material_id: string;
  unit_id: string;
  quantity: string;
  unit_price: string | null;
  note: string | null;
  is_voided: boolean;
  // Its Stock Movement in effect; none once voided.
  stock_movement_id: string | null;
}

// A line of the Material Receipt as the correction sends it, once checked: a recorded line by its id, or a new one.
export interface CorrectionLine {
  line_id: string | null;
  stock_material_id: string;
  unit_id: string;
  // Decimal strings written as PostgreSQL reads them back, so equal values compare equal.
  quantity: string;
  unit_price: string | null;
  note: string | null;
  // คำนวณใหม่ด้วยอัตราแปลงปัจจุบัน (Q29).
  recalculate: boolean;
}

// The Material Receipt as the correction sends it, once checked: the retry fingerprint covers it.
export interface CorrectionFacts {
  received_date: string;
  source_party_id: string | null;
  source_type_id: string | null;
  receipt_reference: string | null;
  note: string | null;
  lines: CorrectionLine[];
  voided_line_ids: string[];
  reason: string;
}

export interface RecordedHeader {
  receipt_number: string;
  received_date: string;
  source_party_id: string | null;
  source_type_id: string | null;
  receipt_reference: string | null;
  note: string | null;
}

export interface ListEntryRead {
  id: string;
  name: string;
  is_active: boolean;
}

// What the correction read under the lock order.
export interface CorrectionReads {
  header: RecordedHeader;
  // For each line the correction sends, its recorded line, or undefined for a new one.
  recorded: (RecordedLine | undefined)[];
  // The recorded lines it voids, in the order `voided_line_ids` names them, and the lines voided before it.
  voided: RecordedLine[];
  voidedBefore: RecordedLine[];
  // The position the first new line takes.
  nextPosition: number;
  // Of every Stock Material its lines name before and after: its name, its Units, its Opening Balance in effect.
  names: Map<string, string>;
  units: Map<string, StockMaterialUnit[]>;
  openingBalances: Map<string, InEffectOpeningBalance>;
  // The Stock Movement in effect of each recorded line it keeps or voids.
  movements: Map<string, StockMovementInEffect>;
  // The Source Party and Source Type before and after, read only when the correction changes them.
  sourceParty: { before: ListEntryRead | null; after: ListEntryRead | null } | null;
  sourceType: { before: ListEntryRead | null; after: ListEntryRead | null } | null;
  // Today in Asia/Bangkok.
  today: string;
}

// A recorded line the correction keeps, with what it sends for it and the Stock Movement it now takes, if its stock
// effect changes.
export interface KeptLine {
  recorded: RecordedLine;
  line: CorrectionLine;
  movement: NormalizedQuantity | null;
}

export interface AddedLine {
  id: string;
  position: number;
  line: CorrectionLine;
  movement: NormalizedQuantity;
}

export interface CorrectionPlan {
  problems: ReceiptConfirmProblem[];
  kept: KeptLine[];
  added: AddedLine[];
  voided: RecordedLine[];
  // The history entry's facts, or null when the correction changes nothing (story 36).
  history: Record<string, unknown> | null;
}

// A Receipt Line's facts as the history records them, each name as it is now (#175 P6).
const lineFactsOf = (
  reads: CorrectionReads,
  line: Pick<CorrectionLine, 'stock_material_id' | 'unit_id' | 'quantity' | 'unit_price' | 'note'>,
  stock: { conversion_factor: string; base_quantity: string }
) => ({
  stock_material: { id: line.stock_material_id, name: reads.names.get(line.stock_material_id)! },
  unit: { id: line.unit_id, name: reads.units.get(line.stock_material_id)!.find(({ unit_id }) => unit_id === line.unit_id)!.name },
  quantity: line.quantity,
  unit_price: line.unit_price,
  note: line.note,
  conversion_factor: stock.conversion_factor,
  base_quantity: stock.base_quantity,
});

type LineFacts = ReturnType<typeof lineFactsOf>;

const stockOf = (movement: StockMovementInEffect | NormalizedQuantity) => ({
  conversion_factor: movement.conversion_snapshot.conversion_factor,
  base_quantity: movement.base_quantity,
});

/**
 * The Receipt Correction of the Material Receipt read as `reads`, sending `facts`: new lines take the ids `newLineIds`.
 * A line's stock effect changes with its Stock Material, Unit or quantity, the Received Date, or a recalculate that
 * finds another Conversion Factor (start decision 3). A quantity or date fix keeps the line's Conversion Snapshot,
 * whatever its Unit is now (Q29; start decision 4); a Stock Material or Unit change, a recalculate and a new line take
 * today's factor of an active Unit (T3's confirm rules).
 */
export function planCorrection(facts: CorrectionFacts, reads: CorrectionReads, newLineIds: string[]): CorrectionPlan {
  const problems: ReceiptConfirmProblem[] = [];
  const dateChanged = facts.received_date !== reads.header.received_date;

  // Today's factor of an active Unit, or the problems that refuse it.
  const atTodaysFactor = (field: string, line: CorrectionLine): NormalizedQuantity | null => {
    const units = reads.units.get(line.stock_material_id)!;
    if (units.some(({ unit_id, is_active }) => unit_id === line.unit_id && !is_active)) {
      problems.push({ field: `${field}.unit_id`, message: `${field}.unit_id names a Unit that is not active on its Stock Material` });
    }
    return normalized(field, units, line);
  };
  const normalized = (field: string, units: readonly StockMaterialUnit[], line: CorrectionLine): NormalizedQuantity | null => {
    const result = normalizeQuantity(units, line.unit_id, line.quantity);
    if (!result.ok) {
      problems.push({ field: `${field}.quantity`, message: `${field}.quantity ${QUANTITY_REFUSALS[result.reason]}` });
      return null;
    }
    return result;
  };

  // A voided line keeps its Stock Material and Unit pair: no line takes it again (start decision 1; review decision 2,
  // 7180557100).
  const voidedPairs = new Map([...reads.voidedBefore, ...reads.voided].map((line) => [pairKey(line), line]));
  facts.lines.forEach((line, index) => {
    const holder = voidedPairs.get(pairKey(line));
    if (holder !== undefined) {
      problems.push({ field: `lines[${index}].unit_id`, message: `lines[${index}].unit_id repeats the Stock Material and Unit of the voided Receipt Line at position ${holder.position}` });
    }
  });

  const kept: KeptLine[] = [];
  const added: AddedLine[] = [];
  const lineEntries: Record<string, unknown>[] = [];
  facts.lines.forEach((line, index) => {
    const field = `lines[${index}]`;
    const recorded = reads.recorded[index];
    if (recorded === undefined) {
      const movement = atTodaysFactor(field, line);
      if (movement !== null) {
        const position = reads.nextPosition + added.length;
        added.push({ id: newLineIds[added.length], position, line, movement });
        lineEntries.push({ change: 'ADDED', line_id: newLineIds[added.length - 1], position, line: lineFactsOf(reads, line, stockOf(movement)) });
      }
      return;
    }
    const inEffect = reads.movements.get(recorded.stock_movement_id!)!;
    const pairChanged = line.stock_material_id !== recorded.stock_material_id || line.unit_id !== recorded.unit_id;
    const quantityChanged = line.quantity !== recorded.quantity;
    let movement: NormalizedQuantity | null = null;
    if (pairChanged || line.recalculate) {
      const atToday = atTodaysFactor(field, line);
      // A recalculate that finds the factor recorded then changes nothing by itself (start decision 3). A refused one
      // leaves `movement` null, its problems named.
      if (pairChanged || quantityChanged || dateChanged || atToday?.conversion_snapshot.conversion_factor !== inEffect.conversion_snapshot.conversion_factor) {
        movement = atToday;
      }
    } else if (quantityChanged || dateChanged) {
      // The Conversion Snapshot recorded then, whatever the Unit is now (Q29; start decision 4).
      const units = reads.units.get(line.stock_material_id)!.map((unit) =>
        unit.unit_id === line.unit_id ? { ...unit, conversion_factor: inEffect.conversion_snapshot.conversion_factor } : unit
      );
      movement = normalized(field, units, line);
    }
    kept.push({ recorded, line, movement });
    const before = lineFactsOf(reads, recorded, stockOf(inEffect));
    const after = lineFactsOf(reads, line, stockOf(movement ?? inEffect));
    // A line that moves records its Conversion Factor and Base Quantity before and after, an unchanged one included
    // (start reading 7163337923; review decision 1, 7180557100).
    const changes = (Object.keys(before) as (keyof LineFacts)[])
      .filter((key) => (movement !== null && (key === 'conversion_factor' || key === 'base_quantity')) || JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .map((key) => ({ field: key, before: before[key], after: after[key] }));
    if (changes.length > 0) {
      lineEntries.push({ change: 'CHANGED', line_id: recorded.id, position: recorded.position, changes });
    }
  });
  for (const recorded of reads.voided) {
    lineEntries.push({ change: 'VOIDED', line_id: recorded.id, position: recorded.position, line: lineFactsOf(reads, recorded, stockOf(reads.movements.get(recorded.stock_movement_id!)!)) });
  }

  if (facts.received_date > reads.today) {
    problems.push({ field: 'received_date', message: `received_date must not be after today (${reads.today}, Asia/Bangkok)` });
  }
  // Q21, on every date a new Stock Movement takes.
  const stocked = [...kept.filter(({ movement }) => movement !== null).map(({ line }) => line), ...added.map(({ line }) => line)];
  for (const line of stocked) {
    const openingBalance = reads.openingBalances.get(line.stock_material_id);
    if (openingBalance !== undefined && facts.received_date <= openingBalance.as_of_date) {
      const field = `lines[${facts.lines.indexOf(line)}]`;
      problems.push({
        field: `${field}.stock_material_id`,
        message: `${field}.stock_material_id names ${reads.names.get(line.stock_material_id)!}, whose Opening Balance ${openingBalance.opening_balance_number} is as of ${openingBalance.as_of_date}: received_date must be after it`,
        in_effect_opening_balance: openingBalance,
      });
    }
  }

  // The header: a newly chosen Source Party or Source Type must be active; one kept may be Inactive by now.
  const changes: Record<string, unknown>[] = [];
  if (dateChanged) {
    changes.push({ field: 'received_date', before: reads.header.received_date, after: facts.received_date });
  }
  for (const [field, read, concept] of [
    ['source_party', reads.sourceParty, 'Source Party'],
    ['source_type', reads.sourceType, 'Source Type'],
  ] as const) {
    if (read === null) {
      continue;
    }
    if (read.after !== null && !read.after.is_active) {
      problems.push({ field: `${field}_id`, message: `${field}_id names ${read.after.name}, a ${concept} that is Inactive` });
    }
    const named = (entry: ListEntryRead | null) => (entry === null ? null : { id: entry.id, name: entry.name });
    changes.push({ field, before: named(read.before), after: named(read.after) });
  }
  for (const field of ['receipt_reference', 'note'] as const) {
    if (facts[field] !== reads.header[field]) {
      changes.push({ field, before: reads.header[field], after: facts[field] });
    }
  }

  const history = changes.length + lineEntries.length === 0 ? null : { receipt_number: reads.header.receipt_number, changes, lines: lineEntries };
  return { problems, kept, added, voided: reads.voided, history };
}
