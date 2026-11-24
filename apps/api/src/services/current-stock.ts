// F010-T2 (#233): the one SQL source of what a Stock Material's Stock Movements give it (#231 P3; ADR 0003;
// CODING_STANDARDS, "A derived condition has one SQL source"): its Current Stock (คงเหลือ), whether it has a Stock
// Movement, whether one is in effect, and Low Stock (ต่ำกว่าขั้นต่ำ). The Stock Material list and page read it, and an
// Opening Balance confirm checks "in effect" through it. No stored copy exists (MSL-06). A leaf of the Stock Movement
// module: it imports nothing.

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
