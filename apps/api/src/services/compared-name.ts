// A name as the catalog compares names: ignoring case and repeated spaces (#175 Q20). Unique indexes are on this same
// expression, written out in their migrations (`grep -l "regexp_replace(btrim" packages/db/src/migrations` finds
// them), and Duplicate Candidates compare Stock Material names by it (F008-T5, #181).
export const comparedName = (expression: string) => `lower(regexp_replace(btrim(${expression}), ' +', ' ', 'g'))`;
