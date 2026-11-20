import { expect } from 'vitest';
import type { ApiHarness } from './api-harness.ts';

// How long `whileHolding` lets `queued` run: longer than `untilWaiting` waits, so its own failure reports first.
const QUEUED_TIMEOUT_MS = 15_000;

// The tables whose rows the services lock for a write.
type LockedTable = 'loans' | 'assets' | 'repair_records' | 'verification_rounds' | 'verification_scope_entries' | 'verification_revisions' | 'units' | 'stock_materials' | 'brands' | 'material_categories';

// How a service locks a row: `FOR UPDATE` to change it, `FOR SHARE` to cite it (CODING_STANDARDS, the foreign key
// paragraph). A share lock is taken in a join, so its wait is matched without `WHERE id`.
type LockMode = 'FOR UPDATE' | 'FOR SHARE';

/**
 * Row lock holders, and waits on the writes they hold back, for Seam A tests of write order.
 * `context` is read on every call, as in `assignmentHelpers`.
 */
export function lockHelpers(context: () => { api: ApiHarness }) {
  // How many writes wait on a row lock of `table`, as the services take it: `FROM <table> WHERE id … FOR UPDATE`,
  // or `FROM <table> … FOR SHARE`, or `JOIN <table> … FOR SHARE OF` it, as F008-T8 locks the Units a Stock Material
  // names; `\M` ends the table's name, so units is not stock_material_units.
  const waitersOnLock = async (table: LockedTable, mode: LockMode): Promise<number> => {
    const res = await context().api.pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ~ $1`,
      [mode === 'FOR UPDATE' ? `FROM ${table} WHERE id.*FOR UPDATE` : `(FROM|JOIN) ${table}\\M.*FOR SHARE`]
    );
    return res.rows[0].n;
  };

  const untilWaiting = async (table: LockedTable, count = 1, mode: LockMode = 'FOR UPDATE'): Promise<void> => {
    await expect.poll(() => waitersOnLock(table, mode), { timeout: 10_000, interval: 50 }).toBeGreaterThanOrEqual(count);
  };

  // Waits until `count` writes wait on the transaction-level advisory lock named `key`, which the services take by
  // its literal name, as F008-T5 does for 'stock-material:identity'.
  const untilWaitingOnAdvisoryLock = async (key: string, count = 1): Promise<void> => {
    const waiters = async (): Promise<number> => {
      const res = await context().api.pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory' AND query LIKE $1`,
        [`%pg_advisory_xact_lock(hashtext('${key}'))%`]
      );
      return res.rows[0].n;
    };
    await expect.poll(waiters, { timeout: 10_000, interval: 50 }).toBeGreaterThanOrEqual(count);
  };

  /**
   * Holds the row `id` of `table` locked, starts `writes`, and runs `queued` under the lock: by default it
   * waits until a write stops at a lock of `table`. The lock goes before the writes are awaited, so a test
   * cannot wait on a write that waits on the lock it holds. However `queued` ends, the lock goes and the
   * writes settle, so a failing assertion leaves nothing locked or running for the tests after it. A `queued`
   * that never ends, such as one waiting on a write the held lock blocks, fails after QUEUED_TIMEOUT_MS.
   */
  const whileHolding = async <R>(
    table: LockedTable,
    id: string,
    writes: () => Promise<R>[],
    queued: () => Promise<void> = () => untilWaiting(table)
  ): Promise<R[]> => holdWhile(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE`, [id], writes, queued);

  /**
   * As `whileHolding`, but what it holds uncommitted is another write's own statement, such as a Verification
   * Correction's `UPDATE verification_revisions SET is_voided = true …`: the write under test must then see
   * that write's result, not only wait for it. `queued` names the lock the writes stop at.
   */
  const whileWriting = async <R>(
    statement: { sql: string; params: unknown[] },
    writes: () => Promise<R>[],
    queued: () => Promise<void>
  ): Promise<R[]> => holdWhile(statement.sql, statement.params, writes, queued);

  const holdWhile = async <R>(sql: string, params: unknown[], writes: () => Promise<R>[], queued: () => Promise<void>): Promise<R[]> => {
    const holder = await context().api.pool.connect();
    let pending: Promise<R>[] = [];
    let failure: { error: unknown } | null = null;
    try {
      await holder.query('BEGIN');
      await holder.query(sql, params);
      pending = writes();
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`whileHolding: queued did not end within ${QUEUED_TIMEOUT_MS} ms`)), QUEUED_TIMEOUT_MS);
      });
      try {
        await Promise.race([queued(), timedOut]);
      } finally {
        clearTimeout(timer);
      }
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

  return { whileHolding, whileWriting, untilWaiting, untilWaitingOnAdvisoryLock };
}
