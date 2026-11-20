// A name as the catalog compares names: ignoring case and repeated spaces (#175 Q20). The unique indexes of the Unit
// list (0025_material_catalog) and of the Brand and Material Category lists (0027_brands_material_categories) are on
// this same expression, and Duplicate Candidates compare Stock Material names by it (F008-T5, #181).
export const comparedName = (expression: string) => `lower(regexp_replace(btrim(${expression}), ' +', ' ', 'g'))`;
