/**
 * Dal — the high-level gateway class for @primebrick/dal-pg.
 *
 * Centralizes three responsibilities that were previously left to the consumer:
 *   1. Type-parser registration (INT8 → bigint, NUMERIC → number/string).
 *   2. Pool ownership & lifecycle (consumer passes connection params; the lib
 *      creates and manages the pg.Pool with best-practice defaults).
 *   3. Singleton gateway per DB connection (one Dal instance per process per
 *      database, reused across all requests — zero per-request allocation).
 *
 * The existing `Repository` class stays exported as the low-level engine (for
 * transaction participation via `withClient`, and for tests that inject a mock
 * Queryable). `Dal` delegates to an internal `Repository(pool)` instance.
 *
 * Pool best practices baked in (the anti-throttling core):
 *   - statement_timeout (default 30s) — the single most impactful setting for
 *     high-async REST traffic. A slow query holding a connection starves the
 *     pool; the per-session timeout guarantees connection release.
 *   - connectionTimeoutMillis (default 5s) — fail fast when pool exhausted.
 *   - search_path set on every connection via onConnect.
 *   - application_name set for PG-side observability (pg_stat_activity).
 *
 * Per-call timeout override:
 *   - Bulk ops (addMany, upsertMany, updateMany): `options.timeoutMs` emits
 *     `SET LOCAL statement_timeout` inside the transaction (transaction-scoped,
 *     no leakage).
 *   - withClient(fn, { timeoutMs }): sets statement_timeout on that specific
 *     client, resets to session default on release.
 *   - Streaming (findAll with stream: true): naturally safe — cursor FETCH per
 *     batch, each bounded by the session default.
 */

import pg, { type Pool, type PoolClient } from "pg";

import { Repository } from "../repository/repository.js";
import { ensureTypeParsers } from "./type-parsers.js";
import { quoteIdent } from "../query/query-builder.js";
import type {
  FindByIdOptions,
  FindByUUIDOptions,
  FindOptions,
  PaginatedEntity,
  WriteOptions,
  BulkOptions,
} from "../types/types.js";
import type { FieldProjector } from "../query/dsl.js";
import type { EntityClass } from "../meta/entity-meta.js";

/** Configuration for the Dal gateway. */
export interface DalConfig {
  /** PostgreSQL connection string. Required. */
  connectionString: string;

  /** Schema to set as search_path on every connection. Default: undefined (uses DB default). */
  schema?: string;

  /** Maximum pool size. Default: 10.
   *  Formula: max ≤ (PG max_connections − reserved) / service_instances.
   *  The lib cannot pick this for you, but it documents it. */
  max?: number;

  /** Per-statement timeout in ms, set via SET statement_timeout on every connection.
   *  Default: 30000. Set to 0 to disable.
   *  This is the full wall-clock (command arrival → server completion → all rows transmitted). */
  statementTimeoutMs?: number;

  /** Time to wait when acquiring a connection from the pool before erroring.
   *  Default: 5000. Fail fast when pool exhausted — don't let requests queue forever. */
  connectionTimeoutMillis?: number;

  /** How long an idle connection is kept before closing. Default: 30000 (pg default). */
  idleTimeoutMillis?: number;

  /** Optional: recycle connections after N uses to clear per-session state.
   *  Default: undefined (off). */
  maxUses?: number;

  /** Optional application_name for PG logging/observability. Default: "primebrick-dal". */
  applicationName?: string;
}

/** Options for withClient — per-connection timeout override. */
export interface WithClientOptions {
  /** Override statement_timeout (ms) for this client. Resets to session default on release. */
  timeoutMs?: number;
}

/** Default values for DalConfig. */
const DEFAULTS = {
  max: 10,
  statementTimeoutMs: 30000,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  applicationName: "primebrick-dal",
} as const;

export class Dal {
  /** The resolved configuration (defaults merged with user-provided config). */
  readonly config: Required<Pick<DalConfig, "connectionString" | "max" | "statementTimeoutMs" | "connectionTimeoutMillis" | "idleTimeoutMillis" | "applicationName">> & Pick<DalConfig, "schema" | "maxUses">;

  private readonly pool: Pool;
  private readonly repo: Repository;
  private closed = false;

  constructor(config: DalConfig) {
    if (!config.connectionString) {
      throw new Error("DalConfig.connectionString is required");
    }

    // Merge with defaults
    this.config = {
      connectionString: config.connectionString,
      schema: config.schema,
      max: config.max ?? DEFAULTS.max,
      statementTimeoutMs: config.statementTimeoutMs ?? DEFAULTS.statementTimeoutMs,
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? DEFAULTS.connectionTimeoutMillis,
      idleTimeoutMillis: config.idleTimeoutMillis ?? DEFAULTS.idleTimeoutMillis,
      maxUses: config.maxUses,
      applicationName: config.applicationName ?? DEFAULTS.applicationName,
    };

    // 1. Register type parsers (idempotent, once per process)
    ensureTypeParsers();

    // 2. Create the pool with best-practice defaults + onConnect session setup
    const poolConfig: pg.PoolConfig = {
      connectionString: this.config.connectionString,
      max: this.config.max,
      connectionTimeoutMillis: this.config.connectionTimeoutMillis,
      idleTimeoutMillis: this.config.idleTimeoutMillis,
      ...(this.config.maxUses !== undefined ? { maxUses: this.config.maxUses } : {}),
    };

    const schema = this.config.schema;
    const statementTimeoutMs = this.config.statementTimeoutMs;
    const applicationName = this.config.applicationName;

    // onConnect: set search_path, statement_timeout, application_name on every
    // new connection. The pg type signature says `(client: ClientBase) => void`
    // but the runtime supports async callbacks (the pool awaits them). We cast
    // to satisfy the type checker while keeping the async behavior.
    const onConnectHandler = async (client: pg.ClientBase): Promise<void> => {
      const statements: string[] = [];
      if (schema) {
        statements.push(`SET search_path TO ${quoteIdent(schema)}`);
      }
      if (statementTimeoutMs !== undefined && statementTimeoutMs !== 0) {
        statements.push(`SET statement_timeout TO ${statementTimeoutMs}`);
      }
      if (applicationName) {
        // Escape single quotes in application_name to prevent injection
        const escaped = applicationName.replace(/'/g, "''");
        statements.push(`SET application_name TO '${escaped}'`);
      }
      if (statements.length > 0) {
        await client.query(statements.join("; "));
      }
    };
    poolConfig.onConnect = onConnectHandler as unknown as pg.PoolConfig["onConnect"];

    this.pool = new pg.Pool(poolConfig);

    // 3. Construct the internal Repository backed by the pool
    this.repo = new Repository(this.pool);
  }

  // ─── Pool lifecycle ───────────────────────────────────────────────────────

  /** The underlying pg.Pool. Exposed for snapshot/migration tooling that needs raw access. */
  getPool(): Pool {
    return this.pool;
  }

  /** Graceful shutdown — drains the pool (calls pool.end()). Call on SIGTERM/SIGINT. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }

  /** Returns true if close() has been called. */
  get isClosed(): boolean {
    return this.closed;
  }

  // ─── Finders (delegate to internal Repository) ────────────────────────────

  async findById<TEntity extends object, TResult = TEntity>(
    entity: EntityClass,
    id: number | string,
    options?: FindByIdOptions,
  ): Promise<TResult | null> {
    return this.repo.findById<TEntity, TResult>(entity, id, options);
  }

  async findByUUID<TEntity extends object, TResult = TEntity>(
    entity: EntityClass,
    uuid: string,
    options?: FindByUUIDOptions,
  ): Promise<TResult | null> {
    return this.repo.findByUUID<TEntity, TResult>(entity, uuid, options);
  }

  async find<TEntity extends object, TResult = TEntity>(
    entity: EntityClass,
    fields?: FieldProjector[] | null,
    options?: FindOptions,
  ): Promise<TResult | null> {
    return this.repo.find<TEntity, TResult>(entity, fields, options);
  }

  async findAll<TEntity extends object, TResult = TEntity>(
    entity: EntityClass,
    fields?: FieldProjector[] | null,
    options?: FindOptions,
  ): Promise<TResult[] | AsyncIterable<TResult>> {
    return this.repo.findAll<TEntity, TResult>(entity, fields, options);
  }

  async findByPage<TEntity extends object, TResult = TEntity>(
    entity: EntityClass,
    page: number,
    recordsPerPage: number,
    fields?: FieldProjector[] | null,
    options?: FindOptions,
  ): Promise<PaginatedEntity<TResult>> {
    return this.repo.findByPage<TEntity, TResult>(entity, page, recordsPerPage, fields, options);
  }

  async count(entity: EntityClass): Promise<number> {
    return this.repo.count(entity);
  }

  // ─── Single-row writes (all RETURNING *, all return TEntity) ───────────────

  async add<TEntity extends object>(
    entity: EntityClass,
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions,
  ): Promise<TEntity> {
    return this.repo.add<TEntity>(entity, row, options);
  }

  async upsert<TEntity extends object>(
    entity: EntityClass,
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & { conflictTarget?: string },
  ): Promise<TEntity> {
    return this.repo.upsert<TEntity>(entity, row, options);
  }

  async update<TEntity extends object>(
    entity: EntityClass,
    uuid: string,
    updates: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions,
  ): Promise<TEntity> {
    return this.repo.update<TEntity>(entity, uuid, updates, options);
  }

  async delete<TEntity extends object>(
    entity: EntityClass,
    uuid: string,
    options: WriteOptions,
  ): Promise<TEntity> {
    return this.repo.delete<TEntity>(entity, uuid, options);
  }

  async restore<TEntity extends object>(
    entity: EntityClass,
    uuid: string,
    options: WriteOptions,
  ): Promise<TEntity> {
    return this.repo.restore<TEntity>(entity, uuid, options);
  }

  async hardDelete<TEntity extends object>(
    entity: EntityClass,
    uuid: string,
    options: WriteOptions,
  ): Promise<void> {
    return this.repo.hardDelete<TEntity>(entity, uuid, options);
  }

  // ─── Bulk writes (TEMP TABLE strategy, batched) ───────────────────────────

  async addMany<TEntity extends object>(
    entity: EntityClass,
    rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: WriteOptions & { batchSize?: number; timeoutMs?: number },
  ): Promise<TEntity[]> {
    return this.repo.addMany<TEntity>(entity, rows, options);
  }

  async upsertMany<TEntity extends object>(
    entity: EntityClass,
    rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: BulkOptions & { timeoutMs?: number },
  ): Promise<TEntity[]> {
    return this.repo.upsertMany<TEntity>(entity, rows, options);
  }

  async updateMany<TEntity extends object>(
    entity: EntityClass,
    updates: Array<{ uuid: string } & Partial<Record<keyof TEntity & string, unknown>>>,
    options: WriteOptions & { batchSize?: number; timeoutMs?: number },
  ): Promise<TEntity[]> {
    return this.repo.updateMany<TEntity>(entity, updates, options);
  }

  async deleteMany<TEntity extends object>(
    entity: EntityClass,
    uuids: string[],
    options: WriteOptions,
  ): Promise<TEntity[]> {
    return this.repo.deleteMany<TEntity>(entity, uuids, options);
  }

  // ─── Raw SQL escape hatch ──────────────────────────────────────────────────

  async rawSql<TResult = unknown>(text: string, values?: unknown[]): Promise<TResult[]> {
    return this.repo.rawSql<TResult>(text, values);
  }

  // ─── Transaction / long-query support ──────────────────────────────────────

  /**
   * Acquires a dedicated client from the pool, optionally sets a per-connection
   * statement_timeout, runs fn(client), and releases the client (resetting the
   * timeout to the session default).
   *
   * Use for:
   * - Transactions (BEGIN/COMMIT inside fn).
   * - Ad-hoc long queries with a timeoutMs override.
   * - Constructing a Repository backed by a specific client for tx participation:
   *   `dal.withClient(async (client) => { const repo = new Repository(client); ... })`.
   */
  async withClient<TResult>(
    fn: (client: PoolClient) => Promise<TResult>,
    options?: WithClientOptions,
  ): Promise<TResult> {
    const client = await this.pool.connect();
    try {
      if (options?.timeoutMs !== undefined) {
        await client.query(`SET statement_timeout TO ${options.timeoutMs}`);
      }
      return await fn(client);
    } finally {
      if (options?.timeoutMs !== undefined) {
        // Reset to the session default configured in onConnect
        const defaultMs = this.config.statementTimeoutMs;
        if (defaultMs !== 0) {
          await client.query(`SET statement_timeout TO ${defaultMs}`);
        } else {
          await client.query("SET statement_timeout TO 0");
        }
      }
      client.release();
    }
  }
}

// ─── Singleton factory ──────────────────────────────────────────────────────

let defaultDal: Dal | null = null;

/**
 * Returns the process-wide singleton Dal instance. Creates it on first call.
 *
 * - First call: requires `config`, creates the singleton.
 * - Subsequent calls with NO config: returns the existing instance.
 * - Subsequent calls with the SAME connectionString: returns the existing instance.
 * - Subsequent calls with a DIFFERENT connectionString: throws (prevents accidental
 *   double-init with wrong params).
 *
 * For multi-DB: construct `new Dal(config)` directly (bypasses the singleton).
 */
export function getDal(config?: DalConfig): Dal {
  if (defaultDal) {
    if (config && defaultDal.config.connectionString !== config.connectionString) {
      throw new Error(
        "getDal: a Dal instance already exists with a different connectionString. Use `new Dal(config)` for multi-DB.",
      );
    }
    return defaultDal;
  }
  if (!config) {
    throw new Error("getDal: config is required on the first call");
  }
  defaultDal = new Dal(config);
  return defaultDal;
}

/**
 * Resets the singleton. Closes the existing instance if any.
 * Intended for tests — call in afterAll to release the pool.
 */
export async function resetDal(): Promise<void> {
  if (defaultDal) {
    await defaultDal.close();
    defaultDal = null;
  }
}
