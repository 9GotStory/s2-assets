import type { ReceiptConfirmProblem } from './material-receipt.service.ts';
import type { InEffectOpeningBalance } from './opening-balance-read.service.ts';
import {
  planStockLines,
  type AddedStockLine,
  type CorrectedStockLine,
  type KeptStockLine,
  type LineStock,
  type RecordedStockLine,
  type StockLineReads,
} from './stock-line-correction.ts';
import { pairKey } from './stock-line-input.ts';

// F010-T6 (#237): what a Receipt Correction (แก้ไขรายการที่บันทึกผิด) does, worked out from the Material Receipt as the
// request sends it and its facts as read under the lock order (#231 P4, P5): the problems that refuse it, each line's
// new Stock Movement where its stock effect changes, the lines it voids and adds, and the history entry "corrected". It
// reads and writes nothing itself; MaterialReceiptService.correct reads its facts and writes what it answers (#231
// Q18, Q29, P9; start comment 7163337923).

// A Receipt Line of a Received Material Receipt, as the correction reads it under the lock.
export interface RecordedLine extends RecordedStockLine {
  unit_price: string | null;
}

// A line of the Material Receipt as the correction sends it, once checked: a recorded line by its id, or a new one.
export interface CorrectionLine extends CorrectedStockLine {
  unit_price: string | null;
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

// What the correction read under the lock order: its lines' reads (stock-line-correction.ts) and its own.
export interface CorrectionReads extends StockLineReads<RecordedLine> {
  header: RecordedHeader;
  // The lines voided before it.
  voidedBefore: RecordedLine[];
  // Of every Stock Material its lines name before and after: its Opening Balance in effect.
  openingBalances: Map<string, InEffectOpeningBalance>;
  // The Source Party and Source Type before and after, read only when the correction changes them.
  sourceParty: { before: ListEntryRead | null; after: ListEntryRead | null } | null;
  sourceType: { before: ListEntryRead | null; after: ListEntryRead | null } | null;
  // Today in Asia/Bangkok.
  today: string;
}

export type KeptLine = KeptStockLine<RecordedLine, CorrectionLine>;
export type AddedLine = AddedStockLine<CorrectionLine>;

export interface CorrectionPlan {
  problems: ReceiptConfirmProblem[];
  kept: KeptLine[];
  added: AddedLine[];
  voided: RecordedLine[];
  // The history entry's facts, or null when the correction changes nothing (story 36).
  history: Record<string, unknown> | null;
}

// A Receipt Line's facts as the history records them, each name as it is now (#175 P6). F010-T7 (#238): the void of a
// whole Material Receipt records each line it voids the same way.
export const lineFactsOf = (
  reads: Pick<CorrectionReads, 'names' | 'units'>,
  line: Pick<CorrectionLine, 'stock_material_id' | 'unit_id' | 'quantity' | 'unit_price' | 'note'>,
  stock: LineStock
) => ({
  stock_material: { id: line.stock_material_id, name: reads.names.get(line.stock_material_id)! },
  unit: { id: line.unit_id, name: reads.units.get(line.stock_material_id)!.find(({ unit_id }) => unit_id === line.unit_id)!.name },
  quantity: line.quantity,
  unit_price: line.unit_price,
  note: line.note,
  conversion_factor: stock.conversion_factor,
  base_quantity: stock.base_quantity,
});

/**
 * The Receipt Correction of the Material Receipt read as `reads`, sending `facts`: new lines take the ids `newLineIds`.
 * Its lines are worked out as every stock record's are (stock-line-correction.ts); the Received Date, the Stock
 * Material and Unit pair of a voided line, the As-of Date rule (Q21) and the Source Party and Source Type are its own.
 */
export function planCorrection(facts: CorrectionFacts, reads: CorrectionReads, newLineIds: string[]): CorrectionPlan {
  const problems: ReceiptConfirmProblem[] = [];
  const dateChanged = facts.received_date !== reads.header.received_date;

  // A voided line keeps its Stock Material and Unit pair: no line takes it again (start decision 1; review decision 2,
  // 7180557100).
  const voidedPairs = new Map([...reads.voidedBefore, ...reads.voided].map((line) => [pairKey(line), line]));
  facts.lines.forEach((line, index) => {
    const holder = voidedPairs.get(pairKey(line));
    if (holder !== undefined) {
      problems.push({ field: `lines[${index}].unit_id`, message: `lines[${index}].unit_id repeats the Stock Material and Unit of the voided Receipt Line at position ${holder.position}` });
    }
  });

  const { problems: lineProblems, kept, added, entries } = planStockLines(facts.lines, reads, dateChanged, newLineIds, (line, stock) => lineFactsOf(reads, line, stock));
  problems.push(...lineProblems);

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

  const history = changes.length + entries.length === 0 ? null : { receipt_number: reads.header.receipt_number, changes, lines: entries };
  return { problems, kept, added, voided: reads.voided, history };
}
