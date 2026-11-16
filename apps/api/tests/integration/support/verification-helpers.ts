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

  // A first result for an Asset in a Round, Found ปกติ unless `payload` says otherwise (F006-T2).
  const finding = (overrides: Record<string, unknown> = {}) => ({ result: 'FOUND', condition: 'NORMAL', ...overrides });

  const record = (roundId: string, assetId: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = context().custodian) =>
    context().api.post(actor, `/verification-rounds/${roundId}/assets/${assetId}/verifications`, payload, { 'x-retry-token': token });

  // A recorded result's answer: its revision and the scope entry's version.
  const recorded = async (roundId: string, assetId: string, overrides: Record<string, unknown> = {}, actor: Actor = context().custodian) => {
    const res = await record(roundId, assetId, finding(overrides), crypto.randomUUID(), actor);
    expect(res.statusCode).toBe(201);
    return res.json();
  };

  // The scope entry of an Asset in a Round, as the Round's entries list it.
  const entryOf = async (roundId: string, assetId: string, actor: Actor = context().reader) => {
    for (let offset = 0; ; offset += 100) {
      const page = await entriesOf(roundId, `limit=100&offset=${offset}`, actor);
      const found = page.items.find((item: any) => item.asset_id === assetId);
      if (found || !page.has_more) {
        return found;
      }
    }
  };

  // F006-T6 (#131): a write that changes a Round, at `path` under it, sent with the version `payload` names.
  const roundWrite =
    (method: 'post' | 'patch', path: string) =>
    (roundId: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = context().custodian) =>
      context().api[method](actor, `/verification-rounds/${roundId}${path}`, payload, { 'x-retry-token': token });
  const close = roundWrite('post', '/close');
  const reopen = roundWrite('post', '/reopen');
  const voidRound = roundWrite('post', '/void');
  const edit = roundWrite('patch', '');

  // A Round closed against the version it has now; answers the version after the close.
  const closed = async (roundId: string, actor: Actor = context().custodian): Promise<number> => {
    const res = await close(roundId, { expected_version: (await roundOf(roundId)).version }, crypto.randomUUID(), actor);
    expect(res.statusCode).toBe(201);
    return res.json().version;
  };

  // A Closed Round reopened against the version it has now, with a reason.
  const reopened = async (roundId: string, reason: string = 'พบผลที่บันทึกผิด', actor: Actor = context().custodian): Promise<number> => {
    const res = await reopen(roundId, { expected_version: (await roundOf(roundId)).version, reason }, crypto.randomUUID(), actor);
    expect(res.statusCode).toBe(201);
    return res.json().version;
  };

  // Closes the open Round, if any, so that the next test can open one (#125 Q17).
  const closeOpenRound = async (): Promise<void> => {
    const open = (await roundsOf()).items.find((round: any) => round.state === 'OPEN');
    if (open) {
      await closed(open.id);
    }
  };

  return {
    opening,
    open,
    opened,
    roundOf,
    roundsOf,
    entriesOf,
    scopeOf,
    finding,
    record,
    recorded,
    entryOf,
    close,
    closed,
    reopen,
    reopened,
    voidRound,
    edit,
    closeOpenRound,
  };
}
