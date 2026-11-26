import * as crypto from 'node:crypto';
import { expect } from 'vitest';
import type { Actor, ApiHarness } from './api-harness.ts';

// F010-T3 (#234): the Material Receipt (รายการรับวัสดุ) writes and reads, as a Supply Officer sends them and a viewer
// reads them, and the Source Party and Source Type entries it names. `context` is read on every call, as in
// `materialHelpers`.
export function materialReceiptHelpers(context: () => { api: ApiHarness; officer: Actor; reader: Actor }) {
  const createDraft = (payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = context().officer) =>
    context().api.post(actor, '/material-receipts', payload, { 'x-retry-token': token });

  // A Draft saved with `payload`, and its id.
  const draft = async (payload: Record<string, unknown> = { lines: [] }): Promise<string> => {
    const res = await createDraft(payload);
    expect(res.statusCode).toBe(201);
    return res.json().material_receipt_id;
  };

  // A Receipt Line of `quantity` in the Unit `unitId` of the Stock Material `stockMaterialId`.
  const line = (stockMaterialId: string, unitId: string | null, quantity: string | null, extra: Record<string, unknown> = {}) => ({
    stock_material_id: stockMaterialId,
    unit_id: unitId,
    quantity,
    ...extra,
  });

  // A Draft that confirms: a Received Date and `lines`.
  const complete = (lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({ received_date: '2026-11-01', lines, ...extra });

  const receiptOf = async (id: string, actor: Actor = context().reader) => {
    const res = await context().api.get(actor, `/material-receipts/${id}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  const replaceDraft = (id: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = context().officer) =>
    context().api.put(actor, `/material-receipts/${id}`, payload, { 'x-retry-token': token });

  const removeDraft = (id: string, version: number, token: string = crypto.randomUUID(), actor: Actor = context().officer) =>
    context().api.post(actor, `/material-receipts/${id}/remove`, { expected_version: version }, { 'x-retry-token': token });

  const confirm = (id: string, version: number, token: string = crypto.randomUUID(), actor: Actor = context().officer) =>
    context().api.post(actor, `/material-receipts/${id}/confirm`, { expected_version: version }, { 'x-retry-token': token });

  // A Material Receipt of `lines` saved and confirmed: its id and Receipt Number.
  const received = async (lines: Record<string, unknown>[], extra: Record<string, unknown> = {}): Promise<{ id: string; number: string }> => {
    const id = await draft(complete(lines, extra));
    const res = await confirm(id, 1);
    expect(res.statusCode).toBe(200);
    return { id, number: res.json().receipt_number };
  };

  // F010-T6 (#237): a Receipt Correction (แก้ไขรายการที่บันทึกผิด) of the Material Receipt `id` with `payload`.
  const correct = (id: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = context().officer) =>
    context().api.post(actor, `/material-receipts/${id}/correct`, payload, { 'x-retry-token': token });

  // The correction that sends the Material Receipt `receipt` as its page read it, every line not voided kept, with the
  // reason `reason`: a test changes what it fixes.
  const correctionAsRead = (receipt: any, reason = 'บันทึกผิด') => ({
    expected_version: receipt.version,
    received_date: receipt.received_date,
    source_party_id: receipt.source_party?.id ?? null,
    source_type_id: receipt.source_type?.id ?? null,
    receipt_reference: receipt.receipt_reference,
    note: receipt.note,
    lines: receipt.lines
      .filter((kept: { is_voided: boolean }) => !kept.is_voided)
      .map((kept: any) => ({
        line_id: kept.id,
        stock_material_id: kept.stock_material.id,
        unit_id: kept.unit.unit_id,
        quantity: kept.quantity,
        unit_price: kept.unit_price,
        note: kept.note,
      })),
    voided_line_ids: [] as string[],
    reason,
  });

  const listOf = async (query = '', actor: Actor = context().reader) => {
    const res = await context().api.get(actor, `/material-receipts?${query}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // The list path of a Source Party (แหล่งที่มา) or a Source Type (วิธีได้มา).
  const LIST_PATHS = { party: '/source-parties', type: '/source-types' } as const;
  type ReceiptList = keyof typeof LIST_PATHS;

  // A new entry of the list `list`, named uniquely unless `name` is given: its id.
  const entryNamed = async (list: ReceiptList, name = `${list === 'party' ? 'ร้าน' : 'วิธี'} ${crypto.randomUUID().slice(0, 8)}`): Promise<string> => {
    const res = await context().api.post(context().officer, LIST_PATHS[list], { name }, { 'x-retry-token': crypto.randomUUID() });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  };

  // The entry `id` of the list `list` as its list reads it.
  const entryOf = async (list: ReceiptList, id: string) => {
    const res = await context().api.get(context().reader, LIST_PATHS[list]);
    expect(res.statusCode).toBe(200);
    return res.json().items.find((entry: { id: string }) => entry.id === id);
  };

  // A status or rename write `action` of the entry `id` at its version now, with `extra`.
  const entryWrite = async (list: ReceiptList, id: string, action: 'inactivate' | 'reactivate' | 'rename', extra: Record<string, unknown> = {}) => {
    const { version } = await entryOf(list, id);
    return context().api.post(context().officer, `${LIST_PATHS[list]}/${id}/${action}`, { expected_version: version, ...extra }, { 'x-retry-token': crypto.randomUUID() });
  };

  return { createDraft, draft, line, complete, receiptOf, replaceDraft, removeDraft, confirm, received, correct, correctionAsRead, listOf, entryNamed, entryOf, entryWrite };
}
