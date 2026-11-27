import * as crypto from 'node:crypto';
import { expect } from 'vitest';
import type { Actor, ApiHarness } from './api-harness.ts';

// F010-T2 (#233): the Opening Balance (ยอดตั้งต้น) writes and reads, as a Supply Officer sends them and a viewer reads
// them. `context` is read on every call, as in `materialHelpers`.
export function openingBalanceHelpers(context: () => { api: ApiHarness; officer: Actor; reader: Actor }) {
  const createDraft = (payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = context().officer) =>
    context().api.post(actor, '/opening-balances', payload, { 'x-retry-token': token });

  // A Draft saved with `payload`, and its id.
  const draft = async (payload: Record<string, unknown> = { lines: [] }): Promise<string> => {
    const res = await createDraft(payload);
    expect(res.statusCode).toBe(201);
    return res.json().opening_balance_id;
  };

  // An Opening Balance line of `quantity` in the Unit `unitId` of the Stock Material `stockMaterialId`.
  const line = (stockMaterialId: string, unitId: string | null, quantity: string | null, extra: Record<string, unknown> = {}) => ({
    stock_material_id: stockMaterialId,
    unit_id: unitId,
    quantity,
    ...extra,
  });

  // A Draft that confirms: an As-of Date, a source and `lines`.
  const complete = (lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({ as_of_date: '2026-09-30', source: 'สมุดคุมวัสดุ', lines, ...extra });

  const openingBalanceOf = async (id: string, actor: Actor = context().reader) => {
    const res = await context().api.get(actor, `/opening-balances/${id}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  const replaceDraft = (id: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = context().officer) =>
    context().api.put(actor, `/opening-balances/${id}`, payload, { 'x-retry-token': token });

  const removeDraft = (id: string, version: number, token: string = crypto.randomUUID(), actor: Actor = context().officer) =>
    context().api.post(actor, `/opening-balances/${id}/remove`, { expected_version: version }, { 'x-retry-token': token });

  const confirm = (id: string, version: number, token: string = crypto.randomUUID(), actor: Actor = context().officer) =>
    context().api.post(actor, `/opening-balances/${id}/confirm`, { expected_version: version }, { 'x-retry-token': token });

  // An Opening Balance of `lines` saved and confirmed: its id and number.
  const confirmed = async (lines: Record<string, unknown>[], extra: Record<string, unknown> = {}): Promise<{ id: string; number: string }> => {
    const id = await draft(complete(lines, extra));
    const res = await confirm(id, 1);
    expect(res.statusCode).toBe(200);
    return { id, number: res.json().opening_balance_number };
  };

  const listOf = async (query = '', actor: Actor = context().reader) => {
    const res = await context().api.get(actor, `/opening-balances?${query}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // F010-T7 (#238): a correction (แก้ไขรายการที่บันทึกผิด) of the Opening Balance `id` with `payload`.
  const correct = (id: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = context().officer) =>
    context().api.post(actor, `/opening-balances/${id}/correct`, payload, { 'x-retry-token': token });

  // The correction that sends the Opening Balance `openingBalance` as its page read it, every line not voided kept, with
  // the reason `reason`: a test changes what it fixes.
  const correctionAsRead = (openingBalance: any, reason = 'บันทึกผิด') => ({
    expected_version: openingBalance.version,
    as_of_date: openingBalance.as_of_date,
    source: openingBalance.source,
    note: openingBalance.note,
    lines: openingBalance.lines
      .filter((kept: { is_voided: boolean }) => !kept.is_voided)
      .map((kept: any) => ({
        line_id: kept.id,
        stock_material_id: kept.stock_material.id,
        unit_id: kept.unit.unit_id,
        quantity: kept.quantity,
        note: kept.note,
      })),
    voided_line_ids: [] as string[],
    reason,
  });

  // F010-T7 (#238): the void of the whole Opening Balance `id` (ยกเลิกรายการ) at `version`, with the reason `reason`.
  const voidOpeningBalance = (id: string, version: number, reason = 'บันทึกผิดทั้งใบ', token: string = crypto.randomUUID(), actor: Actor = context().officer) =>
    context().api.post(actor, `/opening-balances/${id}/void`, { expected_version: version, reason }, { 'x-retry-token': token });

  return { createDraft, draft, line, complete, openingBalanceOf, replaceDraft, removeDraft, confirm, confirmed, listOf, correct, correctionAsRead, voidOpeningBalance };
}
