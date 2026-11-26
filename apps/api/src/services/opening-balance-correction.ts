import type { DatedMaterialReceipt, InEffectMaterialReceipt } from './material-receipt-read.service.ts';
import type { InEffectOpeningBalance } from './opening-balance-read.service.ts';
import type { ConfirmProblem } from './opening-balance.service.ts';
import {
  planStockLines,
  type AddedStockLine,
  type CorrectedStockLine,
  type KeptStockLine,
  type LineStock,
  type RecordedStockLine,
  type StockLineReads,
} from './stock-line-correction.ts';

// F010-T7 (#238): what a correction (แก้ไขรายการที่บันทึกผิด) of a confirmed Opening Balance does, worked out from the
// Opening Balance as the request sends it and its facts as read under the lock order (#231 P4, P5): its lines as every
// stock record's (stock-line-correction.ts), and its own rules: one line per Stock Material, voided lines included
// (start decision 3); a new or changed line only for a Stock Material with no other Stock Movement in effect (Q28;
// start decision 2); an As-of Date no later than today and before every Material Receipt in effect of its Stock
// Materials (Q21). It reads and writes nothing itself; OpeningBalanceService.correct reads its facts and writes what it
// answers.

// The Opening Balance as the correction sends it, once checked: the retry fingerprint covers it.
export interface BalanceCorrectionFacts {
  as_of_date: string;
  // ที่มาของยอด, required (Q13); a blank one is a problem, as at confirm.
  source: string | null;
  note: string | null;
  lines: CorrectedStockLine[];
  voided_line_ids: string[];
  reason: string;
}

export interface BalanceHeader {
  opening_balance_number: string;
  as_of_date: string;
  source: string;
  note: string | null;
}

// What the correction read under the lock order.
export interface BalanceCorrectionReads extends StockLineReads<RecordedStockLine> {
  id: string;
  header: BalanceHeader;
  // Every recorded line, voided ones included.
  recordedLines: RecordedStockLine[];
  // Of each Stock Material a line sends: the Opening Balance and the Material Receipt holding a Stock Movement in
  // effect of it, if any.
  openingBalances: Map<string, InEffectOpeningBalance>;
  receipts: Map<string, InEffectMaterialReceipt>;
  // On an As-of Date change, of each Stock Material a line sends: the earliest Material Receipt in effect dated on or
  // before the new As-of Date.
  receiptsOnOrBefore: Map<string, DatedMaterialReceipt>;
  // Today in Asia/Bangkok.
  today: string;
}

export interface BalanceCorrectionPlan {
  problems: ConfirmProblem[];
  kept: KeptStockLine<RecordedStockLine, CorrectedStockLine>[];
  added: AddedStockLine<CorrectedStockLine>[];
  voided: RecordedStockLine[];
  // The history entry's facts, or null when the correction changes nothing (story 36).
  history: Record<string, unknown> | null;
}

// An Opening Balance line's facts as the history records them, each name as it is now (#175 P6). The void of a whole
// Opening Balance records each line it voids the same way.
export const balanceLineFactsOf = (
  reads: Pick<StockLineReads<RecordedStockLine>, 'names' | 'units'>,
  line: Pick<CorrectedStockLine, 'stock_material_id' | 'unit_id' | 'quantity' | 'note'>,
  stock: LineStock
) => ({
  stock_material: { id: line.stock_material_id, name: reads.names.get(line.stock_material_id)! },
  unit: { id: line.unit_id, name: reads.units.get(line.stock_material_id)!.find(({ unit_id }) => unit_id === line.unit_id)!.name },
  quantity: line.quantity,
  note: line.note,
  conversion_factor: stock.conversion_factor,
  base_quantity: stock.base_quantity,
});

/** The correction of the Opening Balance read as `reads`, sending `facts`: new lines take the ids `newLineIds`. */
export function planBalanceCorrection(facts: BalanceCorrectionFacts, reads: BalanceCorrectionReads, newLineIds: string[]): BalanceCorrectionPlan {
  const problems: ConfirmProblem[] = [];
  const dateChanged = facts.as_of_date !== reads.header.as_of_date;
  const nameOf = (stockMaterialId: string) => reads.names.get(stockMaterialId)!;

  // Start decision 3: a line takes no Stock Material another line of this Opening Balance holds, voided or not.
  facts.lines.forEach((line, index) => {
    const holder = reads.recordedLines.find(({ id, stock_material_id: materialId }) => materialId === line.stock_material_id && id !== reads.recorded[index]?.id);
    if (holder !== undefined) {
      problems.push({
        field: `lines[${index}].stock_material_id`,
        message: `lines[${index}].stock_material_id repeats the Stock Material of the Opening Balance line at position ${holder.position}`,
      });
    }
  });

  const { problems: lineProblems, kept, added, entries } = planStockLines(facts.lines, reads, dateChanged, newLineIds, (line, stock) => balanceLineFactsOf(reads, line, stock));
  problems.push(...lineProblems);

  if (facts.source === null) {
    problems.push({ field: 'source', message: 'source is required' });
  }
  if (facts.as_of_date > reads.today) {
    problems.push({ field: 'as_of_date', message: `as_of_date must not be after today (${reads.today}, Asia/Bangkok)` });
  }
  const changed = new Set(kept.filter(({ ownChange }) => ownChange).map(({ recorded }) => recorded.id));
  facts.lines.forEach((line, index) => {
    const field = `lines[${index}].stock_material_id`;
    const recorded = reads.recorded[index];
    if (recorded === undefined || changed.has(recorded.id)) {
      // Q28 (start decision 2): a new or changed line, on a Stock Material with no Stock Movement in effect that this
      // correction does not reverse. This Opening Balance's own one is its line's, reversed by the change.
      const openingBalance = reads.openingBalances.get(line.stock_material_id);
      const receipt = reads.receipts.get(line.stock_material_id);
      const named = `${field} names ${nameOf(line.stock_material_id)}, a Stock Material with a Stock Movement in effect`;
      if (openingBalance !== undefined && openingBalance.opening_balance_id !== reads.id) {
        const { opening_balance_id: openingBalanceId, opening_balance_number: number } = openingBalance;
        problems.push({ field, message: `${named}, from Opening Balance ${number}`, in_effect_opening_balance: { opening_balance_id: openingBalanceId, opening_balance_number: number } });
      } else if (receipt !== undefined) {
        problems.push({ field, message: `${named}, from Material Receipt ${receipt.receipt_number}`, in_effect_material_receipt: receipt });
      }
      return;
    }
    // Q21: a line moved only by the As-of Date stays before every Material Receipt in effect of its Stock Material.
    const receipt = reads.receiptsOnOrBefore.get(line.stock_material_id);
    if (dateChanged && receipt !== undefined) {
      const { material_receipt_id: materialReceiptId, receipt_number: number } = receipt;
      problems.push({
        field,
        message: `${field} names ${nameOf(line.stock_material_id)}, whose Material Receipt ${number} of ${receipt.received_date} is in effect: as_of_date must be before it`,
        in_effect_material_receipt: { material_receipt_id: materialReceiptId, receipt_number: number },
      });
    }
  });

  const changes: Record<string, unknown>[] = [];
  for (const field of ['as_of_date', 'source', 'note'] as const) {
    if (facts[field] !== reads.header[field]) {
      changes.push({ field, before: reads.header[field], after: facts[field] });
    }
  }
  const history = changes.length + entries.length === 0 ? null : { opening_balance_number: reads.header.opening_balance_number, changes, lines: entries };
  return { problems, kept, added, voided: reads.voided, history };
}
