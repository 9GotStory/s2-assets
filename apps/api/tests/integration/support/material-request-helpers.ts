import * as crypto from 'node:crypto';
import { expect } from 'vitest';
import type { Actor, ApiHarness } from './api-harness.ts';
import { materialHelpers } from './material-helpers.ts';
import { requestableMaterialHelpers } from './requestable-material-helpers.ts';

/**
 * The Material Request writes and reads that the F009 Seam A files share: creating one (F009-T4) and its Cancels
 * (F009-T5). `requester` creates and reads by default, `officer` keeps the Requestable Materials, `reader` reads their
 * pages, and `requestUnit` is the Unit they are asked for in. `context` is read on every call, as in `materialHelpers`.
 */
export function materialRequestHelpers(context: () => { api: ApiHarness; requester: Actor; officer: Actor; reader: Actor; requestUnit: string }) {
  const materials = materialHelpers(() => context());
  const { requestableIn, add } = requestableMaterialHelpers(() => context());

  // A Requestable Material asked for in `requestUnit`, offered through a Compatible Stock Material whose Base Unit is
  // `requestUnit`: its id and the Stock Material's.
  const offeredIn = async (
    requestUnit: string = context().requestUnit,
    { name, wholeNumberOnly = true }: { name?: string; wholeNumberOnly?: boolean } = {}
  ): Promise<{ requestable: string; stockMaterial: string }> => {
    const requestable = await requestableIn(requestUnit, name, { wholeNumberOnly });
    const stockMaterial = await materials.created({ base_unit: { unit_id: requestUnit } });
    expect((await add(requestable, stockMaterial)).statusCode).toBe(200);
    return { requestable, stockMaterial };
  };

  const offered = async (options: { name?: string; wholeNumberOnly?: boolean } = {}): Promise<string> => (await offeredIn(context().requestUnit, options)).requestable;

  const createRequest = (payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = context().requester) =>
    context().api.post(actor, '/material-requests', payload, { 'x-retry-token': token });

  // A Requested Item asking for `quantity` of the Requestable Material `requestable`.
  const item = (requestable: string, quantity = '2', extra: Record<string, unknown> = {}) => ({ requestable_material_id: requestable, requested_quantity: quantity, ...extra });

  // A Material Request of the Requested Items `items` created by `actor`: its id, Request Number and version.
  const created = async (items: Record<string, unknown>[], extra: Record<string, unknown> = {}, actor: Actor = context().requester) => {
    const res = await createRequest({ requested_items: items, ...extra }, crypto.randomUUID(), actor);
    expect(res.statusCode).toBe(201);
    return res.json() as { material_request_id: string; request_number: string; version: number };
  };

  // The Material Request page as `actor` reads it.
  const requestOf = async (id: string, actor: Actor = context().requester) => {
    const res = await context().api.get(actor, `/material-requests/${id}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // What a Cancel takes besides its target: the version it expects (the page's now unless given), a note, a token and
  // the actor.
  interface CancelOptions {
    version?: number;
    note?: string | null;
    token?: string;
    actor?: Actor;
  }
  const cancelBody = async (requestId: string, { version, note }: CancelOptions, actor: Actor) => ({
    expected_version: version ?? (await requestOf(requestId, actor)).version,
    ...(note === undefined ? {} : { note }),
  });

  // Cancels the Requested Item `itemId` of the Material Request `requestId` (F009-T5).
  const cancelItem = async (requestId: string, itemId: string, options: CancelOptions = {}) => {
    const actor = options.actor ?? context().requester;
    return context().api.post(actor, `/material-requests/${requestId}/requested-items/${itemId}/cancel`, await cancelBody(requestId, options, actor), {
      'x-retry-token': options.token ?? crypto.randomUUID(),
    });
  };

  // Cancels every Pending Requested Item of the Material Request `requestId` (F009-T5).
  const cancelRequest = async (requestId: string, options: CancelOptions = {}) => {
    const actor = options.actor ?? context().requester;
    return context().api.post(actor, `/material-requests/${requestId}/cancel`, await cancelBody(requestId, options, actor), {
      'x-retry-token': options.token ?? crypto.randomUUID(),
    });
  };

  return { offeredIn, offered, createRequest, item, created, requestOf, cancelItem, cancelRequest };
}
