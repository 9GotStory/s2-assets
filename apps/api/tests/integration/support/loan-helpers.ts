import * as crypto from 'node:crypto';
import { expect } from 'vitest';
import type { Actor, ApiHarness } from './api-harness.ts';

// A text one character past `length`.
export const over = (length: number) => 'ก'.repeat(length + 1);

/**
 * Registered Assets, what an observer reads of a Loan, and lock holders, for new Seam A tests of
 * Loan writes. `context` is read on every call, as in `assignmentHelpers`.
 */
export function loanHelpers(context: () => { api: ApiHarness; custodian: Actor; reader: Actor }) {
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

  return { registered, loanOf, whileHolding, isWaitingOnLoanLock };
}
