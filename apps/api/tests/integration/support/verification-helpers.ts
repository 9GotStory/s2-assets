import * as crypto from 'node:crypto';
import { expect } from 'vitest';
import type { Actor, ApiHarness } from './api-harness.ts';

/**
 * Verification Rounds opened, and what an observer reads of them, for Seam A tests of Verification.
 * `context` is read on every call, as in `loanHelpers`.
 */
export function verificationHelpers(context: () => { api: ApiHarness; custodian: Actor; reader: Actor }) {
  // A valid opening of a Round over the whole register, unless `overrides` says otherwise.
  const opening = (overrides: Record<string, unknown> = {}) => ({ name: 'ตรวจสอบพัสดุประจำปี', fiscal_year: 2569, ...overrides });

  const open = (payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = context().custodian) =>
    context().api.post(actor, '/verification-rounds', payload, { 'x-retry-token': token });

  // An opened Round's id.
  const opened = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const res = await open(opening(overrides));
    expect(res.statusCode).toBe(201);
    return res.json().verification_round_id;
  };

  const roundOf = async (roundId: string, actor: Actor = context().reader) => {
    const res = await context().api.get(actor, `/verification-rounds/${roundId}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  const roundsOf = async (actor: Actor = context().reader) => {
    const res = await context().api.get(actor, '/verification-rounds');
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // A page of a Round's entries, read with `query`, a URL query string.
  const entriesOf = async (roundId: string, query: string = 'limit=100', actor: Actor = context().reader) => {
    const res = await context().api.get(actor, `/verification-rounds/${roundId}/entries?${query}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // The Assets a Round covers, by id.
  const scopeOf = async (roundId: string): Promise<string[]> => {
    const ids: string[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await entriesOf(roundId, `limit=100&offset=${offset}`);
      ids.push(...page.items.map((entry: any) => entry.asset_id));
      if (!page.has_more) {
        return ids.sort();
      }
    }
  };

  /**
   * Test only, until F006-T6 (#131) closes a Round through the API: marks every open Round closed, so the
   * next test can open one (#125 Q17).
   */
  const closedStandIn = async (): Promise<void> => {
    await context().api.pool.query(`UPDATE verification_rounds SET state = 'CLOSED' WHERE state = 'OPEN'`);
  };

  return { opening, open, opened, roundOf, roundsOf, entriesOf, scopeOf, closedStandIn };
}
