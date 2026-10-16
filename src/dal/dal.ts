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
 * The existing `Repository` class is the query engine (transaction
 * participation via `dal.transaction(fn)` — the callback receives a tx-scoped
 * Repository; for tests that inject a mock Queryable). `Dal` delegates to an
 * internal `Repository(pool)` instance.
 *
 * Connection/client internals are PRIVATE: consumers never see `pg.Pool` or
 * `PoolClient`. Entity ops go through the delegated methods below; atomic
 * multi-write work goes through `transaction()`; infra probes through
 * `serverVersion()`; entity-resolved `TRUNCATE` through `truncate()`.
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
 *   - transaction(fn, { timeoutMs }): same `SET LOCAL` after `BEGIN` —
 *     auto-resets at COMMIT/ROLLBACK.
 *   - Streaming (findAll with stream: true): naturally safe — cursor FETCH per
 *     batch, each bounded by the session default.
 */

import pg, { type Pool, type PoolClient } from "pg";

import { Repository, REPO_INTERNAL } from "../repository/repository.js";
import {
  makeEntityService,
  makeTableAuditPort,
  type EntityService,
  type EntityServiceConfig,
} from "../entity/entity-service.js";
import { DeferredTransaction } from "./deferred-transaction.js";
import { ensureTypeParsers } from "./type-parsers.js";
import { quoteIdent } from "../query/query-builder.js";
import { configureSchemaDomain } from "../meta/schema-domain.js";
import { getQualifiedTableName } from "../meta/entity-decorators.js";
import {
  runPartitionMaintenance,
  type PartitionMaintenanceReport,
} from "./partition-maintenance.js";
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
  BulkResult,
  VectorSearchOptions,
  AuditPort,
} from "../types/types.js";
import type { IAuditableEntity, IDeletableEntity } from "../types/entities.js";
import type { FieldProjector, FieldRef } from "../query/dsl.js";
import type { EntityClass } from "../meta/entity-meta.js";

/** Configuration for the Dal gateway. */
export interface DalConfig {
  /** PostgreSQL connection string. Required. */
  connectionString: string;

  /**
   * Declared schema domain — the ONLY PostgreSQL schemas this service may
   * touch (from `DATABASE_SCHEMA`). `schemas[0]` is the owned/primary schema
   * (patch registry, config_entries live here). Entity operations resolving
   * outside this set throw SchemaDomainViolationError. Required.
   */
  schemas: string[];

  /**
   * Shared table names exempt from the schema-domain check — governed
   * cross-schema table contracts where every module schema carries the
   * same table and a designated manager reaches all of them. Today only
   * `translations` (the BE i18n gateway manages `<module>.translations`
   * for every registered module). The entity's schema pin still applies —
   * only the domain check is bypassed, for that table name only.
   */
  sharedTables?: string[];

  /** Maximum pool size. Default: 10.
   *  Formula: max ≤ (PG max_connections − reserved) / service_instances.
   *  The lib cannot pick this for you, but it documents it. */
  max?: number;

  /** Per-statement timeout in ms, set via SET statement_timeout on every connection.
   *  Default: 30000. Set to 0 to disable.
   *  This is the full wall-clock (command arrival → server completion → all rows transmitted). */
  statementTimeoutMs?: number;

  /** Maximum wall-clock budget in ms for a single *Many operation
   *  (addMany/upsertMany/updateMany/deleteMany). The whole transaction must
   *  complete within this budget — on expiry the work is aborted and the
   *  transaction rolled back (no partial writes).
   *  Default: 1800000 (30 min). Per-call override: `BulkOptions.timeoutMs`.
   *  Set to 0 to disable. */
  bulkTimeoutMs?: number;

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

  /**
   * Optional decorator applied to the Dal's internal root Repository at
   * construction — the governed seam for cross-cutting behavior such as
   * entity caching (`withCache`). The decorated repo backs `dal.entityService`,
   * `dal.tableAuditPort`, and every entity proxy on this instance, so the
   * decoration applies uniformly without consumers building their own
   * repositories. Tx-scoped repositories handed to `dal.transaction(fn)`
   * callbacks are NOT decorated — writes inside an open transaction must
   * not trigger cache writes/invalidation before commit.
   */
  repoDecorator?: (repo: Repository) => Repository;
}

/** Per-operation timeout override for dedicated-client work
 *  (`transaction`, `partitionMaintenance`). */
export interface TimeoutOverrideOptions {
  /** Override statement_timeout (ms). Transaction-scoped for `transaction`
   *  (SET LOCAL, auto-resets at COMMIT/ROLLBACK); connection-scoped with
   *  session-default restore for `partitionMaintenance`. */
  timeoutMs?: number;
}

/** Default values for DalConfig. */
const DEFAULTS = {
  max: 10,
  statementTimeoutMs: 30000,
  bulkTimeoutMs: 1800000,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  applicationName: "primebrick-dal",
} as const;

export class Dal {
  /** The resolved configuration (defaults merged with user-provided config). */
  readonly config: Required<Pick<DalConfig, "connectionString" | "schemas" | "max" | "statementTimeoutMs" | "bulkTimeoutMs" | "connectionTimeoutMillis" | "idleTimeoutMillis" | "applicationName">> & Pick<DalConfig, "maxUses" | "sharedTables" | "repoDecorator">;

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
      schemas: config.schemas,
      max: config.max ?? DEFAULTS.max,
      statementTimeoutMs: config.statementTimeoutMs ?? DEFAULTS.statementTimeoutMs,
      bulkTimeoutMs: config.bulkTimeoutMs ?? DEFAULTS.bulkTimeoutMs,
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? DEFAULTS.connectionTimeoutMillis,
      idleTimeoutMillis: config.idleTimeoutMillis ?? DEFAULTS.idleTimeoutMillis,
      maxUses: config.maxUses,
      sharedTables: config.sharedTables,
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

    // Register the declared schema domain — every entity operation that
    // resolves outside `schemas` throws SchemaDomainViolationError.
    const domain = configureSchemaDomain(this.config.schemas, this.config.sharedTables ?? []);
    const searchPath = [...new Set([...this.config.schemas, "public"])];
    const statementTimeoutMs = this.config.statementTimeoutMs;
    const applicationName = this.config.applicationName;

    // onConnect: set search_path, statement_timeout, application_name on every
    // new connection. The pg type signature says `(client: ClientBase) => void`
    // but the runtime supports async callbacks (the pool awaits them). We cast
    // to satisfy the type checker while keeping the async behavior.
    const onConnectHandler = async (client: pg.ClientBase): Promise<void> => {
      const statements: string[] = [];
      if (domain) {
        // Declared schemas first (primary = [0]); `public` stays last —
        // extensions (pgvector types/operators) live there and must resolve
        // unqualified, but it grants no data-table fallback since entity
        // refs are schema-qualified by the domain guard.
        statements.push(`SET search_path TO ${searchPath.map(quoteIdent).join(", ")}`);
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
    this.repo =
      this.config.repoDecorator?.(new Repository(this.pool, REPO_INTERNAL, this.config.bulkTimeoutMs)) ??
      new Repository(this.pool, REPO_INTERNAL, this.config.bulkTimeoutMs);
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
    id: bigint | string,
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

  async count(entity: EntityClass): Promise<bigint> {
    return this.repo.count(entity);
  }

  /**
   * pgvector nearest-neighbour search — see `Repository.vectorSearch`.
   * `ORDER BY <vectorField> <op> $n::vector LIMIT <topK>` with the query
   * vector bound as a parameter (HNSW/ivfflat-safe). `similarity` score for
   * cosine (`<=>`), raw `distance` for other operators.
   */
  async vectorSearch<TEntity extends object, TResult = TEntity>(
    entity: EntityClass,
    vectorField: FieldRef<TEntity, keyof TEntity & string>,
    queryVector: number[] | string,
    options?: VectorSearchOptions<TEntity>,
  ): Promise<Array<TResult & { similarity?: number; distance?: number }>> {
    return this.repo.vectorSearch(entity, vectorField, queryVector, options);
  }

  // ─── Single-row writes (RETURNING honors TResult via options.returning) ────

  async add<TEntity extends object & IAuditableEntity, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions<TEntity>,
  ): Promise<TResult>;
  async add<TEntity extends object, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions<TEntity>,
  ): Promise<TResult>;
  async add<TEntity extends object, TResult = TEntity>(
    entity: EntityClass,
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions<TEntity> | AuditableWriteOptions<TEntity>,
  ): Promise<TResult> {
    return (this.repo as any).add(entity, row, options);
  }

  // upsert (single-record) removed — see Repository for rationale. Use add()/update().
  //   async upsert<TEntity extends object & IAuditableEntity>(
  //     entity: EntityClass & { new (): TEntity },
  //     row: Partial<Record<keyof TEntity & string, unknown>>,
  //     options: AuditableWriteOptions & UpsertOptions,
  //   ): Promise<TEntity>;
  //   async upsert<TEntity extends object>(
  //     entity: EntityClass & { new (): TEntity },
  //     row: Partial<Record<keyof TEntity & string, unknown>>,
  //     options: WriteOptions & UpsertOptions,
  //   ): Promise<TEntity>;
  //   async upsert<TEntity extends object>(
  //     entity: EntityClass,
  //     row: Partial<Record<keyof TEntity & string, unknown>>,
  //     options: (WriteOptions | AuditableWriteOptions) & UpsertOptions,
  //   ): Promise<TEntity> {
  //     return (this.repo as any).upsert(entity, row, options);
  //   }

  async update<TEntity extends object & IAuditableEntity, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    updates: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Promise<TResult>;
  async update<TEntity extends object, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    updates: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Promise<TResult>;
  async update<TEntity extends object, TResult = TEntity>(
    entity: EntityClass,
    updates: Partial<Record<keyof TEntity & string, unknown>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Promise<TResult> {
    return (this.repo as any).update(entity, updates, options);
  }

  async delete<TEntity extends object & IAuditableEntity & IDeletableEntity, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Promise<TResult>;
  async delete<TEntity extends object & IDeletableEntity, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Promise<TResult>;
  async delete<TEntity extends object, TResult = TEntity>(
    entity: EntityClass,
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Promise<TResult> {
    return (this.repo as any).delete(entity, match, options);
  }

  async restore<TEntity extends object & IAuditableEntity & IDeletableEntity, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Promise<TResult>;
  async restore<TEntity extends object & IDeletableEntity, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Promise<TResult>;
  async restore<TEntity extends object, TResult = TEntity>(
    entity: EntityClass,
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Promise<TResult> {
    return (this.repo as any).restore(entity, match, options);
  }

  async hardDelete<TEntity extends object & IAuditableEntity, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Promise<TResult>;
  async hardDelete<TEntity extends object, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Promise<TResult>;
  async hardDelete<TEntity extends object, TResult = TEntity>(
    entity: EntityClass,
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Promise<TResult> {
    return (this.repo as any).hardDelete(entity, match, options);
  }

  // ─── Bulk writes (TEMP TABLE strategy, batched) ───────────────────────────

  async addMany<TEntity extends object & IAuditableEntity>(
    entity: EntityClass & { new (): TEntity },
    rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: AuditableWriteOptions & BulkOptions,
  ): Promise<BulkResult>;
  async addMany<TEntity extends object>(
    entity: EntityClass & { new (): TEntity },
    rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: WriteOptions & BulkOptions,
  ): Promise<BulkResult>;
  async addMany<TEntity extends object>(
    entity: EntityClass,
    rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: (WriteOptions | AuditableWriteOptions) & BulkOptions,
  ): Promise<BulkResult> {
    return (this.repo as any).addMany(entity, rows, options);
  }

  async hardDeleteMany<TEntity extends object & IAuditableEntity>(
    entity: EntityClass & { new (): TEntity },
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<BulkResult>;
  async hardDeleteMany<TEntity extends object>(
    entity: EntityClass & { new (): TEntity },
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: WriteOptions & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<BulkResult>;
  async hardDeleteMany<TEntity extends object>(
    entity: EntityClass,
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<BulkResult> {
    return (this.repo as any).hardDeleteMany(entity, matches, options);
  }

  // ─── upsertMany — COMMENTED OUT pending guarded/unguarded decision ────
  // Upsert conflict path overwrites unconditionally (no version guard).
  // Parked until we decide guarded vs sync-import semantics.
  // async upsertMany<TEntity extends object & IAuditableEntity>(
  //   entity: EntityClass & { new (): TEntity },
  //   rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
  //   options: AuditableWriteOptions & BulkOptions & UpsertOptions,
  // ): Promise<BulkResult>;
  // async upsertMany<TEntity extends object>(
  //   entity: EntityClass & { new (): TEntity },
  //   rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
  //   options: WriteOptions & BulkOptions & UpsertOptions,
  // ): Promise<BulkResult>;
  // async upsertMany<TEntity extends object>(
  //   entity: EntityClass,
  //   rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
  //   options: (WriteOptions | AuditableWriteOptions) & BulkOptions & UpsertOptions,
  // ): Promise<BulkResult> {
  //   return (this.repo as any).upsertMany(entity, rows, options);
  // }

  async restoreMany<TEntity extends object & IAuditableEntity & IDeletableEntity>(
    entity: EntityClass & { new (): TEntity },
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<BulkResult>;
  async restoreMany<TEntity extends object & IDeletableEntity>(
    entity: EntityClass & { new (): TEntity },
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: WriteOptions & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<BulkResult>;
  async restoreMany<TEntity extends object>(
    entity: EntityClass,
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<BulkResult> {
    return (this.repo as any).restoreMany(entity, matches, options);
  }

  async updateMany<TEntity extends object & IAuditableEntity>(
    entity: EntityClass & { new (): TEntity },
    updates: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<BulkResult>;
  async updateMany<TEntity extends object>(
    entity: EntityClass & { new (): TEntity },
    updates: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: WriteOptions & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<BulkResult>;
  async updateMany<TEntity extends object>(
    entity: EntityClass,
    updates: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<BulkResult> {
    return (this.repo as any).updateMany(entity, updates, options);
  }

  async deleteMany<TEntity extends object & IAuditableEntity & IDeletableEntity>(
    entity: EntityClass & { new (): TEntity },
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Promise<BulkResult>;
  async deleteMany<TEntity extends object & IDeletableEntity>(
    entity: EntityClass & { new (): TEntity },
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Promise<BulkResult>;
  async deleteMany<TEntity extends object>(
    entity: EntityClass,
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Promise<BulkResult> {
    return (this.repo as any).deleteMany(entity, matches, options);
  }

  // ─── Owned factories / infrastructure ──────────────────────────────────────

  /**
   * The public path to the generic entity-service worker. The gateway
   * injects its own (schema-domain-guarded, pool-scoped) Repository — the
   * consumer never sees it. `cfg.repo` exists only as a decorator seam
   * (e.g. BE `withCache`): leave it unset for the standard wiring.
   */
  entityService<TEntity extends Record<string, unknown>>(
    cfg: EntityServiceConfig<TEntity>,
  ): EntityService<TEntity> {
    return makeEntityService({ ...cfg, repo: cfg.repo ?? this.repo });
  }

  /**
   * The standard `{table}_audit` writer port, bound to the gateway
   * Repository. Use for adapters that need an AuditPort without exposing
   * the Repository itself.
   */
  tableAuditPort(): AuditPort {
    return makeTableAuditPort(this.repo);
  }

  /**
   * Server version + connectivity probe in one call. A successful response
   * already proves the connection is alive — there is deliberately no
   * separate `ping()` (a dedicated `SELECT 1` would be a redundant round-trip).
   * Throws on connectivity/timeout failure.
   */
  async serverVersion(): Promise<{ server_version: string; version: string }> {
    const r = await this.pool.query<{ server_version: string; version: string }>(
      "SELECT current_setting('server_version') AS server_version, version() AS version",
    );
    return r.rows[0]!;
  }

  /**
   * Atomic multi-statement work — `BEGIN`/`COMMIT`/`ROLLBACK` around a
   * tx-scoped Repository. Use for cascades, multi-write units, and any
   * sequence that must commit or fail as one. Post-commit side effects
   * (cache invalidation, events) belong AFTER this resolves, never inside.
   */
  async transaction<TResult>(
    fn: (txRepo: Repository) => Promise<TResult>,
    options?: TimeoutOverrideOptions,
  ): Promise<TResult> {
    return this.withClient(async (client) => {
      await client.query("BEGIN");
      try {
        if (options?.timeoutMs !== undefined) {
          // SET LOCAL is transaction-scoped — auto-resets at COMMIT/ROLLBACK,
          // no session-default restore needed.
          await client.query(`SET LOCAL statement_timeout TO ${options.timeoutMs}`);
        }
        const result = await fn(new Repository(client, REPO_INTERNAL, this.config.bulkTimeoutMs));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    });
  }

  /**
   * Deferred fluent transaction — buffer repository ops (`tx.add`, `tx.update`,
   * `tx.find`, …) without executing, then `tx.commit()` compiles and runs them
   * as ONE data-modifying CTE statement. Atomicity is PostgreSQL's
   * single-statement guarantee — no BEGIN/COMMIT/ROLLBACK and no rollback
   * path exist in this mode. Inter-op values flow via `Deferred.ref()`;
   * conditional TS logic on mid-flow results stays in `transaction(fn)`.
   */
  beginTransaction(options?: TimeoutOverrideOptions): DeferredTransaction {
    return new DeferredTransaction(
      (text, values) => this.withClient((c) => c.query(text, values), options),
      this.config.bulkTimeoutMs,
    );
  }

  /**
   * Physical table reset — delegates to `Repository.truncate` (entity-resolved,
   * schema-domain guarded). For auditable tables prefer soft-delete; TRUNCATE
   * is for caches, KB stores, and test teardown.
   */
  async truncate(
    entity: EntityClass,
    options?: { restartIdentity?: boolean; cascade?: boolean },
  ): Promise<void> {
    return this.repo.truncate(entity, options);
  }

  // ─── Transaction / long-query support ──────────────────────────────────────

  /**
   * INTERNAL — dedicated-client acquisition for Dal internals only
   * (`transaction`, `partitionMaintenance`). Not part of the consumer API:
   * it exposes a raw `PoolClient` (`client.query` = unguarded SQL), so it is
   * `private`. Consumer transactions go through `dal.transaction(fn)`, which
   * hands out only a tx-scoped `Repository`.
   */
  private async withClient<TResult>(
    fn: (client: PoolClient) => Promise<TResult>,
    options?: TimeoutOverrideOptions,
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

  // ─── Partition maintenance ────────────────────────────────────────────────

  /**
   * pg_partman retention executor — metadata-driven, identical for every
   * service. Purges `@PartitionChildOf` children of expired parents (before
   * the partition drop), removes expired strays from the default partition,
   * then runs `partman.run_maintenance_proc()`. Called by the service's
   * `jobs.due.system.<svc>.partition-maintenance` consumer.
   *
   * @param entities the service's entity registry (only `@PartitionField`
   *   entities participate; everything else is ignored)
   */
  async partitionMaintenance(
    entities: readonly EntityClass[],
    options?: TimeoutOverrideOptions,
  ): Promise<PartitionMaintenanceReport> {
    return this.withClient((client) => runPartitionMaintenance(client, entities), options);
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
