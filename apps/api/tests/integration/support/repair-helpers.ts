import * as crypto from 'node:crypto';
import { expect } from 'vitest';
import type { Actor, ApiHarness } from './api-harness.ts';

// What a test file's Repair Records are, unless a call says otherwise.
export interface RepairDefaults {
  startDate: string;
}

/**
 * Repair Records started and ended, and what an observer reads of them, for Seam A tests of repairs.
 * `context` is read on every call, as in `loanHelpers`.
 */
export function repairHelpers(context: () => { api: ApiHarness; custodian: Actor; reader: Actor }, defaults: RepairDefaults) {
  // A valid Repair Start of `assetId`, of kind ซ่อม by an internal Repairer, unless `overrides` says otherwise.
  const base = (assetId: string, overrides: Record<string, unknown> = {}) => ({
    asset_id: assetId,
    repair_kind: 'REPAIR',
    start_date: defaults.startDate,
    repairer: { kind: 'INTERNAL' },
    symptom_or_work: 'เปิดไม่ติด',
    ...overrides,
  });

  const send = (payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = context().custodian) =>
    context().api.post(actor, '/repairs', payload, { 'x-retry-token': token });

  // An Asset sent for repair, and its Repair Record's id.
  const sent = async (assetId: string, overrides: Record<string, unknown> = {}): Promise<string> => {
    const res = await send(base(assetId, overrides));
    expect(res.statusCode).toBe(201);
    return res.json().repair_record_id;
  };

  const recordOf = async (repairRecordId: string, actor: Actor = context().reader) => {
    const res = await context().api.get(actor, `/repairs/${repairRecordId}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  const recordsOf = async (assetId: string) => {
    const res = await context().api.get(context().reader, `/assets/${assetId}/repairs`);
    expect(res.statusCode).toBe(200);
    return res.json().records;
  };

  // A request to record the Repair Outcome of `repairRecordId`, against its latest version unless
  // `fields` names one: ใช้งานได้ on the file's Start Date.
  const recordOutcome = async (repairRecordId: string, fields: Record<string, unknown> = {}, token: string = crypto.randomUUID(), actor: Actor = context().custodian) =>
    context().api.post(
      actor,
      `/repairs/${repairRecordId}/outcome`,
      { expected_version: (await recordOf(repairRecordId)).version, outcome: 'USABLE', outcome_date: defaults.startDate, ...fields },
      { 'x-retry-token': token }
    );

  // A Repair Record ended with its Repair Outcome.
  const ended = async (repairRecordId: string, fields: Record<string, unknown> = {}) => {
    const res = await recordOutcome(repairRecordId, fields);
    expect(res.statusCode).toBe(201);
    return res.json();
  };

  return { base, send, sent, recordOf, recordsOf, recordOutcome, ended };
}
