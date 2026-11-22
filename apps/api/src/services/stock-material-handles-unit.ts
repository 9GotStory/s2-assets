// F009-T2 (#204): SQL another module joins to ask whether a Stock Material handles a Unit. A leaf of the Stock Material
// module (CODING_STANDARDS, "A feature's code gets its own files", "A derived condition has one SQL source"): it
// imports nothing.

/**
 * SQL that holds when the Stock Material whose id is the SQL expression `stockMaterialId` has the Unit whose id is the
 * SQL expression `unitId` among its active Units, as its Base Unit or an active Alternate Unit: what a Compatible
 * Stock Material needs of the Request Unit (#202 MRQ-28, Q7, ADR 0002).
 */
export const handlesUnit = (stockMaterialId: string, unitId: string): string =>
  `EXISTS (SELECT 1 FROM stock_material_units hu WHERE hu.stock_material_id = ${stockMaterialId} AND hu.unit_id = ${unitId} AND hu.is_active)`;
