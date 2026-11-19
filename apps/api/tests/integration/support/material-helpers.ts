import * as crypto from 'node:crypto';
import { expect } from 'vitest';
import type { Actor, ApiHarness } from './api-harness.ts';

/**
 * Units and Stock Materials written through the catalog API, for Seam A tests of Feature 008.
 * `context` is read on every call, as in `loanHelpers`.
 */
export function materialHelpers(context: () => { api: ApiHarness; officer: Actor; reader: Actor }) {
  // Adds a Unit to the shared list.
  const addUnit = (name: string, token: string = crypto.randomUUID(), actor: Actor = context().officer) =>
    context().api.post(actor, '/units', { name }, { 'x-retry-token': token });

  // A Unit added to the list, named `name` or uniquely, and its id.
  const unitNamed = async (name: string = `หน่วย ${crypto.randomUUID().slice(0, 8)}`): Promise<string> => {
    const res = await addUnit(name);
    expect(res.statusCode).toBe(201);
    return res.json().id;
  };

  // The Unit list as a viewer reads it.
  const unitsOf = async (actor: Actor = context().reader) => {
    const res = await context().api.get(actor, '/units');
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  const createMaterial = (payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = context().officer) =>
    context().api.post(actor, '/stock-materials', payload, { 'x-retry-token': token });

  // A Stock Material created with `overrides` over a name and a Base Unit, and its id. It confirms any Duplicate
  // Candidate (F008-T5), as tests name many Stock Materials alike.
  const created = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const res = await createMaterial({ name: `วัสดุ ${crypto.randomUUID().slice(0, 8)}`, base_unit: { unit_id: await unitNamed() }, explicit_continuation: true, ...overrides });
    expect(res.statusCode).toBe(201);
    return res.json().stock_material_id;
  };

  // The Stock Material page as a viewer reads it.
  const materialOf = async (id: string, actor: Actor = context().reader) => {
    const res = await context().api.get(actor, `/stock-materials/${id}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // Replaces the Units of the Stock Material `id` (F008-T3).
  const replaceUnits = (id: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = context().officer) =>
    context().api.put(actor, `/stock-materials/${id}/units`, payload, { 'x-retry-token': token });

  // The Units write that keeps a Stock Material's page as it is, at its version, for a test to change.
  const unitsAsRead = (page: { version: number; units: { unit_id: string; is_base: boolean; conversion_factor: string | null; whole_number_only: boolean; is_active: boolean }[] }) => {
    const base = page.units.find((unit) => unit.is_base)!;
    return {
      expected_version: page.version,
      base_unit: { unit_id: base.unit_id, whole_number_only: base.whole_number_only },
      alternate_units: page.units
        .filter((unit) => !unit.is_base)
        .map(({ unit_id, conversion_factor, whole_number_only, is_active }) => ({ unit_id, conversion_factor, whole_number_only, is_active })),
    };
  };

  // Adds an entry to the Brand or the Material Category list (F008-T4).
  const addBrand = (name: string, token: string = crypto.randomUUID(), actor: Actor = context().officer) =>
    context().api.post(actor, '/brands', { name }, { 'x-retry-token': token });
  const addMaterialCategory = (name: string, token: string = crypto.randomUUID(), actor: Actor = context().officer) =>
    context().api.post(actor, '/material-categories', { name }, { 'x-retry-token': token });

  // A Brand or a Material Category added to its list, named `name` or uniquely, and its id.
  const brandNamed = async (name: string = `ยี่ห้อ ${crypto.randomUUID().slice(0, 8)}`): Promise<string> => {
    const res = await addBrand(name);
    expect(res.statusCode).toBe(201);
    return res.json().id;
  };
  const materialCategoryNamed = async (name: string = `หมวด ${crypto.randomUUID().slice(0, 8)}`): Promise<string> => {
    const res = await addMaterialCategory(name);
    expect(res.statusCode).toBe(201);
    return res.json().id;
  };

  // Changes the other details of the Stock Material `id`: its Material Category and note (F008-T4).
  const changeDetails = (id: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = context().officer) =>
    context().api.put(actor, `/stock-materials/${id}/details`, payload, { 'x-retry-token': token });

  // The Duplicate Candidates a viewer looks up with `query`: a name, and a Stock Material to leave out (F008-T5).
  const duplicateCandidatesOf = (query: string, actor: Actor = context().reader) => context().api.get(actor, `/stock-materials/duplicate-candidates?${query}`);

  // A Material Correction of the Stock Material `id` (F008-T5).
  const correct = (id: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = context().officer) =>
    context().api.post(actor, `/stock-materials/${id}/corrections`, payload, { 'x-retry-token': token });

  // Makes the Stock Material `id` Inactive (หยุดใช้), or reactivates it (เปิดใช้อีกครั้ง) (F008-T7).
  const inactivate = (id: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = context().officer) =>
    context().api.post(actor, `/stock-materials/${id}/inactivate`, payload, { 'x-retry-token': token });
  const reactivate = (id: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = context().officer) =>
    context().api.post(actor, `/stock-materials/${id}/reactivate`, payload, { 'x-retry-token': token });

  // How many Stock Materials exist, to show that a refused write saved nothing.
  const materialCount = async (): Promise<number> => {
    const res = await context().api.get(context().reader, '/stock-materials?limit=1');
    expect(res.statusCode).toBe(200);
    return res.json().total_count;
  };

  return { addUnit, unitNamed, unitsOf, createMaterial, created, materialOf, replaceUnits, unitsAsRead, addBrand, addMaterialCategory, brandNamed, materialCategoryNamed, changeDetails, duplicateCandidatesOf, correct, inactivate, reactivate, materialCount };
}
