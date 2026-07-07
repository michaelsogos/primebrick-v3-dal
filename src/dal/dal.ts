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
  AuditableWriteOptions,
  MatchByOptions,
  BulkOptions,
  UpsertOptions,
} from "../types/types.js";
import type { IAuditableEntity, IDeletableEntity } from "../types/entities.js";
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
  private _isClosing = false;

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

  /**
   * Graceful shutdown — drains the pool with a timeout deadline.
   *
   * - Re-entrant: concurrent calls return immediately (the first call wins).
   * - Timeout: if pool.end() doesn't complete within timeoutMs, the promise
   *   resolves anyway (the pool is left to be reaped by the OS/TCP stack).
   * - Error containment: if pool.end() throws, the error is logged and swallowed.
   * - Does NOT install process.on() handlers — that is a consumer-side concern.
   *
   * @param timeoutMs Maximum time to wait for pool.end() to complete. Default: 10000.
   */
  async close(timeoutMs: number = 10000): Promise<void> {
    if (this.closed || this._isClosing) return;
    this._isClosing = true;

    try {
      await Promise.race([
        this.pool.end(),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    } catch (err) {
      console.error("[dal-pg] pool.end() failed during close:", err);
    } finally {
      this.closed = true;
      this._isClosing = false;
    }
  }

  /** Returns true if close() has completed. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Returns true if close() is currently in progress (started but not finished). */
  get isClosing(): boolean {
    return this._isClosing;
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

  async add<TEntity extends object & IAuditableEntity>(
    entity: EntityClass & { new (): TEntity },
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions,
  ): Promise<TEntity>;
  async add<TEntity extends object>(
    entity: EntityClass & { new (): TEntity },
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions,
  ): Promise<TEntity>;
  async add<TEntity extends object>(
    entity: EntityClass,
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions | AuditableWriteOptions,
  ): Promise<TEntity> {
    return (this.repo as any).add(entity, row, options);
  }

  async upsert<TEntity extends object & IAuditableEntity>(
    entity: EntityClass & { new (): TEntity },
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions & UpsertOptions,
  ): Promise<TEntity>;
  async upsert<TEntity extends object>(
    entity: EntityClass & { new (): TEntity },
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & UpsertOptions,
  ): Promise<TEntity>;
  async upsert<TEntity extends object>(
    entity: EntityClass,
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: (WriteOptions | AuditableWriteOptions) & UpsertOptions,
  ): Promise<TEntity> {
    return (this.repo as any).upsert(entity, row, options);
  }

  async update<TEntity extends object & IAuditableEntity>(
    entity: EntityClass & { new (): TEntity },
    updates: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Promise<TEntity>;
  async update<TEntity extends object>(
    entity: EntityClass & { new (): TEntity },
    updates: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Promise<TEntity>;
  async update<TEntity extends object>(
    entity: EntityClass,
    updates: Partial<Record<keyof TEntity & string, unknown>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Promise<TEntity> {
    return (this.repo as any).update(entity, updates, options);
  }

  async delete<TEntity extends object & IAuditableEntity & IDeletableEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Promise<TEntity>;
  async delete<TEntity extends object & IDeletableEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Promise<TEntity>;
  async delete<TEntity extends object>(
    entity: EntityClass,
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Promise<TEntity> {
    return (this.repo as any).delete(entity, match, options);
  }

  async restore<TEntity extends object & IAuditableEntity & IDeletableEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Promise<TEntity>;
  async restore<TEntity extends object & IDeletableEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Promise<TEntity>;
  async restore<TEntity extends object>(
    entity: EntityClass,
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Promise<TEntity> {
    return (this.repo as any).restore(entity, match, options);
  }

  async hardDelete<TEntity extends object & IAuditableEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Promise<void>;
  async hardDelete<TEntity extends object>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Promise<void>;
  async hardDelete<TEntity extends object>(
    entity: EntityClass,
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Promise<void> {
    return (this.repo as any).hardDelete(entity, match, options);
  }

  // ─── Bulk writes (TEMP TABLE strategy, batched) ───────────────────────────

  async addMany<TEntity extends object & IAuditableEntity>(
    entity: EntityClass & { new (): TEntity },
    rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: AuditableWriteOptions & BulkOptions,
  ): Promise<TEntity[]>;
  async addMany<TEntity extends object>(
    entity: EntityClass & { new (): TEntity },
    rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: WriteOptions & BulkOptions,
  ): Promise<TEntity[]>;
  async addMany<TEntity extends object>(
    entity: EntityClass,
    rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: (WriteOptions | AuditableWriteOptions) & BulkOptions,
  ): Promise<TEntity[]> {
    return (this.repo as any).addMany(entity, rows, options);
  }

  async upsertMany<TEntity extends object & IAuditableEntity>(
    entity: EntityClass & { new (): TEntity },
    rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: AuditableWriteOptions & BulkOptions & UpsertOptions,
  ): Promise<TEntity[]>;
  async upsertMany<TEntity extends object>(
    entity: EntityClass & { new (): TEntity },
    rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: WriteOptions & BulkOptions & UpsertOptions,
  ): Promise<TEntity[]>;
  async upsertMany<TEntity extends object>(
    entity: EntityClass,
    rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: (WriteOptions | AuditableWriteOptions) & BulkOptions & UpsertOptions,
  ): Promise<TEntity[]> {
    return (this.repo as any).upsertMany(entity, rows, options);
  }

  async updateMany<TEntity extends object & IAuditableEntity>(
    entity: EntityClass & { new (): TEntity },
    updates: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<TEntity[]>;
  async updateMany<TEntity extends object>(
    entity: EntityClass & { new (): TEntity },
    updates: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: WriteOptions & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<TEntity[]>;
  async updateMany<TEntity extends object>(
    entity: EntityClass,
    updates: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<TEntity[]> {
    return (this.repo as any).updateMany(entity, updates, options);
  }

  async deleteMany<TEntity extends object & IAuditableEntity & IDeletableEntity>(
    entity: EntityClass & { new (): TEntity },
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Promise<TEntity[]>;
  async deleteMany<TEntity extends object & IDeletableEntity>(
    entity: EntityClass & { new (): TEntity },
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Promise<TEntity[]>;
  async deleteMany<TEntity extends object>(
    entity: EntityClass,
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Promise<TEntity[]> {
    return (this.repo as any).deleteMany(entity, matches, options);
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
