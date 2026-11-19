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

  // A Stock Material created with `overrides` over a name and a Base Unit, and its id.
  const created = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const res = await createMaterial({ name: `วัสดุ ${crypto.randomUUID().slice(0, 8)}`, base_unit: { unit_id: await unitNamed() }, ...overrides });
    expect(res.statusCode).toBe(201);
    return res.json().stock_material_id;
  };

  // The Stock Material page as a viewer reads it.
  const materialOf = async (id: string, actor: Actor = context().reader) => {
    const res = await context().api.get(actor, `/stock-materials/${id}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // How many Stock Materials exist, to show that a refused write saved nothing.
  const materialCount = async (): Promise<number> => {
    const res = await context().api.get(context().reader, '/stock-materials?limit=1');
    expect(res.statusCode).toBe(200);
    return res.json().total_count;
  };

  return { addUnit, unitNamed, unitsOf, createMaterial, created, materialOf, materialCount };
}
