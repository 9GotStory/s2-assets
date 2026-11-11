import { expect } from 'vitest';
import type { ApiHarness } from './api-harness.ts';

// The tables whose rows the services lock for a write.
type LockedTable = 'loans' | 'assets' | 'repair_records';

/**
 * Row lock holders, and waits on the writes they hold back, for Seam A tests of write order.
 * `context` is read on every call, as in `assignmentHelpers`.
 */
export function lockHelpers(context: () => { api: ApiHarness }) {
  // How many writes wait on a row lock of `table`, as the services take it: `FROM <table> WHERE id … FOR UPDATE`.
  const waitersOnLock = async (table: LockedTable): Promise<number> => {
    const res = await context().api.pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1`,
      [`%FROM ${table} WHERE id%FOR UPDATE%`]
    );
    return res.rows[0].n;
  };

  const untilWaiting = async (table: LockedTable, count = 1): Promise<void> => {
    await expect.poll(() => waitersOnLock(table), { timeout: 10_000, interval: 50 }).toBeGreaterThanOrEqual(count);
  };

  /**
   * Holds the row `id` of `table` locked, starts `writes`, and runs `queued` under the lock: by default it
   * waits until a write stops at a lock of `table`. The lock goes before the writes are awaited, so a test
   * cannot wait on a write that waits on the lock it holds. However `queued` ends, the lock goes and the
   * writes settle, so a failing assertion leaves nothing locked or running for the tests after it.
   */
  const whileHolding = async <R>(
    table: LockedTable,
    id: string,
    writes: () => Promise<R>[],
    queued: () => Promise<void> = () => untilWaiting(table)
  ): Promise<R[]> => {
    const holder = await context().api.pool.connect();
    let pending: Promise<R>[] = [];
    let failure: { error: unknown } | null = null;
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
      pending = writes();
      await queued();
    } catch (error) {
      failure = { error };
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    if (failure) {
      await Promise.allSettled(pending);
      throw failure.error;
    }
    return Promise.all(pending);
  };

  return { whileHolding, untilWaiting };
}
