import * as crypto from 'node:crypto';
import { expect } from 'vitest';
import type { Actor, ApiHarness } from './api-harness.ts';

// What a test file's Retirements are, unless a call says otherwise.
export interface RetirementDefaults {
  retirementDate: string;
}

/**
 * Retirements recorded, for Seam A tests of Retirements and of the writes a Retired Asset refuses.
 * `context` is read on every call, as in `loanHelpers`.
 */
export function retirementHelpers(context: () => { api: ApiHarness; custodian: Actor }, defaults: RetirementDefaults) {
  // A valid Retirement: sold on the file's Retirement Date, unless `overrides` says otherwise.
  const base = (overrides: Record<string, unknown> = {}) => ({ retirement_date: defaults.retirementDate, retirement_method: 'SALE', ...overrides });

  const retire = (assetId: string, payload: Record<string, unknown> = base(), token: string = crypto.randomUUID(), actor: Actor = context().custodian) =>
    context().api.post(actor, `/assets/${assetId}/retirements`, payload, { 'x-retry-token': token });

  // A Retired Asset, and its Retirement's id.
  const retired = async (assetId: string, overrides: Record<string, unknown> = {}): Promise<string> => {
    const res = await retire(assetId, base(overrides));
    expect(res.statusCode).toBe(201);
    return res.json().retirement_id;
  };

  return { base, retire, retired };
}
