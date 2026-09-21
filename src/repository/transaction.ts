/**
 * runInTransaction — atomic multi-statement writes.
 *
 * `Repository` already accepts a `Queryable` (Pool | PoolClient) at
 * construction time, so a tx-scoped Repository is the DAL-native way to run
 * commands on a transaction instead of the pool connection: callers get a
 * `PoolClient`, construct `new Repository(client)` (or pass the client to DAL
 * methods accepting `tx`), and every write lands on the tx.
 *
 * Semantics:
 * - `fn` receives the checked-out `PoolClient` bound to an open transaction.
 * - COMMIT on success; ROLLBACK on any throw; the client is always released.
 * - Errors propagate unchanged — PG raised exceptions (e.g. optimistic-lock
 *   ERR01) keep their `code` so the HTTP layer maps them (409 RFC7807).
 *
 * Post-commit work (cache invalidation, notifications) belongs AFTER this
 * function resolves — never inside `fn`, or a rollback would leave stale
 * evictions.
 */

import type { Pool, PoolClient } from "pg";

export async function runInTransaction<T>(
  pool: Pool,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
