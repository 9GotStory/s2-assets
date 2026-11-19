// F008-T4 (#179): the Brand and Material Category lists, and their join for another module's read, as unit-entries.ts
// gives the Unit list's (CODING_STANDARDS, "A feature's code gets its own files"). catalog-list.service.ts owns the
// tables. This module imports nothing, so any service can use it without an import cycle.

/** Each list: its table, its history table, the column that names one of its entries, and its concept. */
export const CATALOG_LISTS = Object.freeze({
  brand: { table: 'brands', history: 'brand_history', column: 'brand_id', concept: 'Brand' },
  'material-category': { table: 'material_categories', history: 'material_category_history', column: 'material_category_id', concept: 'Material Category' },
} as const);

export type CatalogListKind = keyof typeof CATALOG_LISTS;

/** An entry of the Brand or the Material Category list under a name: its name now on a Stock Material, its name then in a history entry (#175 P6). */
export interface NamedListEntry {
  id: string;
  name: string;
}

/** Left-joins the entry `alias` of the list `kind` that `idExpression` names, which may be none. */
export const joinCatalogListEntry = (kind: CatalogListKind, alias: string, idExpression: string): string =>
  `LEFT JOIN ${CATALOG_LISTS[kind].table} ${alias} ON ${alias}.id = ${idExpression}`;
