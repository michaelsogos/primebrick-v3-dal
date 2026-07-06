/**
 * Streaming wrapper for pg-query-stream.
 *
 * When `findAll` is called with `{ stream: true }`, the Repository uses this
 * module to create a `QueryStream` and returns an `AsyncIterable` that yields
 * rows one-by-one — without buffering the entire result set in memory.
 *
 * IMPORTANT: pg-query-stream requires a dedicated client (not pool.query()).
 * If a Pool is passed, we acquire a client via pool.connect() and release it
 * when the stream ends/errors. If a PoolClient is passed, the caller owns
 * the lifecycle.
 */

import QueryStream from "pg-query-stream";
import { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool, "query" | "connect"> | Pick<PoolClient, "query">;

/**
 * Creates an AsyncIterable from a SQL query using pg-query-stream.
 *
 * @param db - The pg Pool or PoolClient
 * @param text - SQL query text
 * @param values - Parameter values
 * @returns AsyncIterable that yields rows one-by-one
 *
 * @example
 * ```ts
 * const stream = createStream(pool, "SELECT * FROM users", []);
 * for await (const row of stream) {
 *   console.log(row);
 * }
 * ```
 */
export function createStream<TResult = unknown>(
  db: Queryable,
  text: string,
  values: unknown[]
): AsyncIterable<TResult> {
  const qs = new QueryStream(text, values);

  // Check if db is a Pool (has `connect`) — we need a dedicated client
  const isPool = typeof (db as Pool).connect === "function";

  if (isPool) {
    const pool = db as Pool;
    // Return an AsyncIterable that acquires a client lazily on first iteration
    return {
      async *[Symbol.asyncIterator]() {
        const client = await pool.connect();
        try {
          const stream = client.query(qs) as AsyncIterable<TResult>;
          yield* stream;
        } finally {
          client.release();
        }
      },
    };
  }

  // PoolClient — caller owns lifecycle
  const client = db as PoolClient;
  const stream = client.query(qs) as AsyncIterable<TResult>;
  return stream;
}
