// A name as the catalog compares names: ignoring case and repeated spaces (#175 Q20). The unique indexes of the Unit
// list (0025_material_catalog), of the Brand and Material Category lists (0027_brands_material_categories) and of the
// Requestable Materials (0029_requestable_materials, F009-T1) are on this same expression, and Duplicate Candidates
// compare Stock Material names by it (F008-T5, #181).
export const comparedName = (expression: string) => `lower(regexp_replace(btrim(${expression}), ' +', ' ', 'g'))`;
