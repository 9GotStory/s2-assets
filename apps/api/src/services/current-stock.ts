// F010-T2 (#233): the one SQL source of what a Stock Material's Stock Movements give it (#231 P3; ADR 0003;
// CODING_STANDARDS, "A derived condition has one SQL source"): its Current Stock (คงเหลือ), whether it has a Stock
// Movement, whether one is in effect, and Low Stock (ต่ำกว่าขั้นต่ำ). The Stock Material list and page read it, and an
// Opening Balance confirm checks "in effect" through it. No stored copy exists (MSL-06). A leaf of the Stock Movement
// module: it imports nothing.
// F010-T4 (#235): and the running balance after each Stock Movement in the business timeline.

/**
 * SQL holding when the Stock Movement joined as `movement` is in effect: neither a Reversal nor reversed by one (#231
 * Q28). An Opening Balance line points at it; T6 and T7 reverse it.
 */
export const stockMovementInEffect = (movement: string): string =>
  `(${movement}.reverses_stock_movement_id IS NULL AND NOT EXISTS (SELECT 1 FROM stock_movements rv WHERE rv.reverses_stock_movement_id = ${movement}.id))`;

/**
 * A LATERAL subquery for `CROSS JOIN LATERAL`, one row however many there are, over the Stock Movements of the Stock Material whose id is the
 * SQL expression `stockMaterialId`, giving:
 * - `current_stock`: the sum of their Base Quantities in the Base Unit (MSL-03), or NULL when there is none;
 * - `has_stock_movement`: whether any exists, Reversals included;
 * - `has_stock_movement_in_effect`: whether one is in effect (Q28).
 */
export const stockFiguresOf = (stockMaterialId: string): string =>
  `(SELECT sum(sf.base_quantity) AS current_stock,
           count(*) > 0 AS has_stock_movement,
           coalesce(bool_or(${stockMovementInEffect('sf')}), false) AS has_stock_movement_in_effect
    FROM stock_movements sf
    WHERE sf.stock_material_id = ${stockMaterialId})`;

/**
 * SQL holding when a Stock Material is Low Stock, over the figures joined as `figures` (from `stockFiguresOf`) and its
 * Minimum Stock, the SQL expression `minimumStock`: it has a Stock Movement, a Minimum Stock is set, and its Current
 * Stock is below it (Q22, MC-20).
 */
export const lowStock = (figures: string, minimumStock: string): string =>
  `(${figures}.has_stock_movement AND ${minimumStock} IS NOT NULL AND ${figures}.current_stock < ${minimumStock})`;

/**
 * F010-T4 (#235): a subquery of the Stock Movements of the Stock Material whose id is the SQL expression
 * `stockMaterialId`, each with every column of stock_movements and:
 * - `balance`: the sum of the Base Quantities up to and including it, the stock right after it (#231 P3);
 * - `position`: its place in the business timeline, from 1.
 * Both follow the timeline: Effective Date, then Recorded At, then id (MSL-07, MSL-12), so a backdated fact takes its
 * place by its Effective Date. The window spans every Stock Movement of the Stock Material, so a filter over the rows
 * keeps each balance the whole ledger's: the ledger never restarts at a new year (MSL-09; #235 start decision 4).
 */
export const stockLedgerOf = (stockMaterialId: string): string =>
  `(SELECT sl.*, sum(sl.base_quantity) OVER timeline AS balance, row_number() OVER timeline AS position
    FROM stock_movements sl
    WHERE sl.stock_material_id = ${stockMaterialId}
    WINDOW timeline AS (ORDER BY sl.effective_date, sl.recorded_at, sl.id))`;

/**
 * F010-T4 (#235): SQL giving, as an integer, the Fiscal Year (ปีงบประมาณ) of the date expression `date`: the period from
 * 1 October to 30 September it falls in, named by the Buddhist-era year in which that period ends (#231 P3, MSL-11).
 * NULL for a NULL date. A Fiscal Year is worked out, never stored, and a new one moves no stock (MSL-09).
 */
export const fiscalYearOf = (date: string): string => `(extract(year FROM ${date})::int + CASE WHEN extract(month FROM ${date}) >= 10 THEN 544 ELSE 543 END)`;

/**
 * F010-T4 (#235): SQL holding when the date expression `date` falls in the Fiscal Year that the integer SQL expression
 * `fiscalYear` names, as a range of dates, so an index on the date serves it (#231 P3).
 */
export const inFiscalYear = (date: string, fiscalYear: string): string =>
  `(${date} >= make_date(${fiscalYear} - 544, 10, 1) AND ${date} < make_date(${fiscalYear} - 543, 10, 1))`;
