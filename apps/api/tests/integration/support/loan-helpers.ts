import * as crypto from 'node:crypto';
import { expect } from 'vitest';
import type { Actor, ApiHarness } from './api-harness.ts';

// A text one character past `length`.
export const over = (length: number) => 'ก'.repeat(length + 1);

// What a test file's Loans are, unless a call says otherwise.
export interface LoanDefaults {
  loanDate: string;
  dueDate: string;
  // The External Borrower's contact name.
  contactName?: string;
}

/**
 * Registered Assets, Loans started and ended, what an observer reads of a Loan, and lock holders, for
 * Seam A tests of Loans. `context` is read on every call, as in `assignmentHelpers`.
 */
export function loanHelpers(context: () => { api: ApiHarness; custodian: Actor; reader: Actor }, defaults?: LoanDefaults) {
  const registered = async (name: string = `ของ ${crypto.randomUUID()}`): Promise<string> => {
    const { api, custodian } = context();
    const res = await api.post(custodian, '/assets', { name });
    expect(res.statusCode).toBe(201);
    return res.json().asset.id;
  };

  const loanOf = async (loanId: string, actor: Actor = context().reader) => {
    const res = await context().api.get(actor, `/loans/${loanId}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  // A request to start a Loan of `assetIds` in ปกติ, with the file's dates and External Borrower.
  const start = (assetIds: string[], overrides: Record<string, unknown> = {}) => {
    const { api, custodian } = context();
    return api.post(
      custodian,
      '/loans',
      {
        assets: assetIds.map((asset_id) => ({ asset_id, condition: 'NORMAL' })),
        borrower: { kind: 'EXTERNAL', contact_name: defaults?.contactName ?? 'คุณผู้ยืม' },
        loan_date: defaults?.loanDate,
        due_date: defaults?.dueDate,
        ...overrides,
      },
      { 'x-retry-token': crypto.randomUUID() }
    );
  };

  // A started Loan of `assetIds`, with its LoanItem ids by Asset.
  const lent = async (assetIds: string[], overrides: Record<string, unknown> = {}) => {
    const res = await start(assetIds, overrides);
    expect(res.statusCode).toBe(201);
    const { loan_id: loanId, version, items } = res.json();
    return {
      loanId: loanId as string,
      version: version as number,
      itemOf: Object.fromEntries(items.map(({ id, asset_id }: any) => [asset_id, id])) as Record<string, string>,
    };
  };

  // A Loan Return of `itemIds` on `returnDate`, against the Loan's latest version.
  const returned = async (loanId: string, itemIds: string[], returnDate: string, condition: 'NORMAL' | 'DAMAGED' = 'NORMAL') => {
    const { api, custodian } = context();
    const res = await api.post(
      custodian,
      `/loans/${loanId}/returns`,
      { expected_version: (await loanOf(loanId)).version, return_date: returnDate, items: itemIds.map((loan_item_id) => ({ loan_item_id, condition })) },
      { 'x-retry-token': crypto.randomUUID() }
    );
    expect(res.statusCode).toBe(201);
  };

  // Not Returned for `itemIds` on `notReturnedDate`, against the Loan's latest version.
  const closedNotReturned = async (loanId: string, itemIds: string[], notReturnedDate: string) => {
    const { api, custodian } = context();
    const res = await api.post(
      custodian,
      `/loans/${loanId}/not-returned`,
      { expected_version: (await loanOf(loanId)).version, not_returned_date: notReturnedDate, reason: 'ผู้ยืมแจ้งว่าทำหาย', items: itemIds.map((loan_item_id) => ({ loan_item_id })) },
      { 'x-retry-token': crypto.randomUUID() }
    );
    expect(res.statusCode).toBe(201);
  };

  // Runs `work` while a row is held locked, and lets the lock go however `work` ends, so that a
  // failing assertion cannot leave the row locked for the tests after it.
  const whileHolding = async <T>(table: 'loans' | 'assets', id: string, work: () => Promise<T>): Promise<T> => {
    const { api } = context();
    const holder = await api.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
      return await work();
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
  };

  const isWaitingOnLoanLock = async (): Promise<boolean> => {
    const res = await context().api.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FROM loans WHERE id%FOR UPDATE%'`);
    return res.rows[0].n > 0;
  };

  return { registered, loanOf, start, lent, returned, closedNotReturned, whileHolding, isWaitingOnLoanLock };
}
