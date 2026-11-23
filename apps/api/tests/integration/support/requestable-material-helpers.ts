import * as crypto from 'node:crypto';
import { expect } from 'vitest';
import type { Actor, ApiHarness } from './api-harness.ts';

/**
 * The Requestable Material writes and reads that the F009 Seam A files share (#205 review decision 2, comment
 * 7079864346). `officer` keeps them and `reader` reads the page. `context` is read on every call, as in
 * `materialHelpers`.
 */
export function requestableMaterialHelpers(context: () => { api: ApiHarness; officer: Actor; reader: Actor }) {
  // A Requestable Material asked for in `requestUnit`, named `name` or uniquely, whole-number-only unless told
  // otherwise, and its id (F009-T1).
  const requestableIn = async (requestUnit: string, name = `วัสดุขอเบิก ${crypto.randomUUID().slice(0, 8)}`, { wholeNumberOnly = true }: { wholeNumberOnly?: boolean } = {}): Promise<string> => {
    const res = await context().api.post(
      context().officer,
      '/requestable-materials',
      { name, request_unit_id: requestUnit, whole_number_only: wholeNumberOnly },
      { 'x-retry-token': crypto.randomUUID() }
    );
    expect(res.statusCode).toBe(201);
    return res.json().requestable_material_id;
  };

  // The Requestable Material page as `actor` reads it (F009-T1).
  const requestableOf = async (id: string, actor: Actor = context().reader) => {
    const res = await context().api.get(actor, `/requestable-materials/${id}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // Adds the Stock Material `stockMaterialId` as a Compatible Stock Material of `requestableId`, at `version` or the
  // version the page has now (F009-T2).
  const add = async (
    requestableId: string,
    stockMaterialId: string,
    { version, token = crypto.randomUUID(), actor = context().officer }: { version?: number; token?: string; actor?: Actor } = {}
  ) =>
    context().api.post(
      actor,
      `/requestable-materials/${requestableId}/compatible-stock-materials`,
      { stock_material_id: stockMaterialId, expected_version: version ?? (await requestableOf(requestableId)).version },
      { 'x-retry-token': token }
    );

  // Ends the Compatible Stock Material `stockMaterialId` of `requestableId`, at `version` or the version the page has
  // now (F009-T2).
  const end = async (
    requestableId: string,
    stockMaterialId: string,
    { version, token = crypto.randomUUID(), actor = context().officer }: { version?: number; token?: string; actor?: Actor } = {}
  ) =>
    context().api.post(
      actor,
      `/requestable-materials/${requestableId}/compatible-stock-materials/${stockMaterialId}/end`,
      { expected_version: version ?? (await requestableOf(requestableId)).version },
      { 'x-retry-token': token }
    );

  // Makes the Requestable Material `id` Inactive ("หยุดใช้") or reactivates it ("เปิดใช้อีกครั้ง"), at `version` or the
  // version the page has now (F009-T7).
  const changeStatus =
    (action: 'inactivate' | 'reactivate') =>
    async (id: string, { version, token = crypto.randomUUID(), actor = context().officer }: { version?: number; token?: string; actor?: Actor } = {}) =>
      context().api.post(actor, `/requestable-materials/${id}/${action}`, { expected_version: version ?? (await requestableOf(id)).version }, { 'x-retry-token': token });
  const inactivate = changeStatus('inactivate');
  const reactivate = changeStatus('reactivate');

  // Renames the Requestable Material `id` to `name` ("เปลี่ยนชื่อ"), at `version` or the version the page has now
  // (F009-T8).
  const rename = async (id: string, name: string, { version, token = crypto.randomUUID(), actor = context().officer }: { version?: number; token?: string; actor?: Actor } = {}) =>
    context().api.post(actor, `/requestable-materials/${id}/rename`, { expected_version: version ?? (await requestableOf(id)).version, name }, { 'x-retry-token': token });

  // Changes the Other Details of the Requestable Material `id` ("แก้ไขข้อมูลอื่น"): its page's description,
  // whole-number setting and Request Unit, with `changes` over them, at `version` or the version the page has now
  // (F009-T8).
  const changeDetails = async (
    id: string,
    changes: { description?: string | null; whole_number_only?: boolean; request_unit_id?: string },
    { version, token = crypto.randomUUID(), actor = context().officer }: { version?: number; token?: string; actor?: Actor } = {}
  ) => {
    const page = await requestableOf(id);
    const payload = { expected_version: version ?? page.version, description: page.description, whole_number_only: page.whole_number_only, request_unit_id: page.request_unit.unit_id, ...changes };
    return context().api.put(actor, `/requestable-materials/${id}/details`, payload, { 'x-retry-token': token });
  };

  return { requestableIn, requestableOf, add, end, inactivate, reactivate, rename, changeDetails };
}
