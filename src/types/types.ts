/**
 * Public DAL types — options, ports, paginated results.
 *
 * The DAL uses **ports** (interfaces) for audit and logging so consumers can
 * inject their own implementations. If no port is injected, the DAL silently
 * skips audit/logging — microservices that don't need it aren't forced to
 * implement it.
 */

import type { FilterExpr, SortingExpr, JoinExpr, FieldProjector } from "../query/dsl.js";

/** Controls how soft-deleted rows (deleted_at IS NOT NULL) are handled in finders. */
export type WithDeletedRecords = "EXCLUDED" | "ONLY" | "INCLUDED";

/** Options for `findById`. */
export type FindByIdOptions = {
  /** If true (default), throw `NotFoundError` when rowcount !== 1. */
  throwIfNotFound?: boolean;
  deletedRecords?: WithDeletedRecords;
};

/** Options for `find`, `findAll`, `findByPage`. */
export type FindOptions = {
  /** If true (default for `find`), throw `NotFoundError` when rowcount !== 1. Set to false to return null. */
  throwIfNotFound?: boolean;
  deletedRecords?: WithDeletedRecords;
  filters?: FilterExpr[];
  sorting?: SortingExpr[];
  joins?: JoinExpr[];
  /** When true, stream results via pg-query-stream instead of buffering. */
  stream?: boolean;
  /** Override the table name (e.g., for audit trail tables: "customers_audit"). */
  tableName?: string;
};

/** Options for `findByUUID`. */
export type FindByUUIDOptions = {
  throwIfNotFound?: boolean;
  deletedRecords?: WithDeletedRecords;
};

/** Paginated result wrapper. */
export type PaginatedEntity<TEntity> = {
  entities: TEntity[];
  total_records: bigint;
};

/** Insert conflict semantics for `add()`. */
export type OnConflictMode =
  /**
   * Default. A unique/exclusion conflict raises a typed PG error:
   * `ERR04` when the conflicting row is live, `ERR05` when it is
   * soft-deleted (`deleted_at` set → restore it, never duplicate).
   * Generated as a CTE: `ins` (INSERT ... ON CONFLICT DO NOTHING
   * RETURNING), `conflict` (matches the pre-existing row by unique-group
   * values), `raised` (`pg_raise`). The conflicting row's `uuid` and the
   * matched constraint name travel in the error `detail` (jsonb).
   */
  | "raise"
  /**
   * Bare `ON CONFLICT DO NOTHING` — the conflicting row is skipped without
   * raising, so the surrounding transaction survives. `add()` returns
   * `undefined` when the row was skipped (RETURNING yields zero rows).
   * For statement-level idempotent inserts (e.g. piggybacked translations
   * inside an entity-write transaction).
   */
  | "ignore";

/** Base write options — no actor (for non-auditable entities). */
export type WriteOptions<TEntity extends object = Record<string, unknown>> = {
  /** Optional audit port — if not injected, audit is silently skipped. */
  audit?: AuditPort;
  /** Optional logger port — if not injected, errors are swallowed. */
  logger?: LoggerPort;
  /** Override the table name (e.g., for audit trail tables: "customers_audit"). */
  tableName?: string;
  /**
   * Conflict semantics for `add()`. Default `"raise"` — see
   * {@link OnConflictMode}. `"ignore"` is reserved for statement-level
   * idempotent inserts that must not abort an open transaction.
   */
  onConflict?: OnConflictMode;
  /**
   * `add()` + `onConflict: "raise"` only. Restricts conflict identification
   * to the unique constraint defined by these entity property keys — they
   * must exactly match one `@Unique` group (single column or named
   * composite). Defaults to every unique group whose attempted values are
   * all known — payload values (including a caller-provided `uuid`),
   * constant `defaultSql` literals, or NULL when the column is omitted
   * without a default. Groups containing columns with volatile DB-side
   * defaults (`gen_random_uuid()`, `identity` PK, `now()`) are excluded
   * automatically since their attempted value is unknowable.
   * Unknown keys throw `UnknownColumnError`; a set matching no unique
   * group throws `ValidationError`.
   */
  conflictKeys?: (keyof TEntity & string)[];
  /**
   * Projection applied to the write's RETURNING clause.
   * - `undefined` (default): every persisted column EXCEPT the identity PK
   *   (`id` bigint — not JSON-safe), aliased to its TS property key.
   * - `FieldProjector[]`: only these fields/expressions are returned —
   *   honors `<TEntity, TResult>`: the result object carries exactly the
   *   projected keys/aliases. Projections must target the base entity —
   *   RETURNING cannot reference joined tables.
   * Internal bookkeeping columns (`id`, `uuid`, `version`) are always
   * emitted for the audit path, then stripped from the returned object.
   */
  returning?: FieldProjector[];
};

/** Write options for auditable entities — actor is required. */
export type AuditableWriteOptions<TEntity extends object = Record<string, unknown>> = WriteOptions<TEntity> & {
  /** The actor performing the operation (stamped into created_by/updated_by/deleted_by). */
  actor: string;
};

/** Options for match-by operations (update, delete, restore, hardDelete, *Many). */
export type MatchByOptions<TEntity> = {
  /**
   * Non-standard identity selectors — an array of `@Unique`/`@Key` entity
   * properties used as AND-match conditions on top of any `id`/`uuid`
   * present in the payload. A prop belonging to a composite `@Unique`
   * group pulls in the WHOLE group (all group props required in payload).
   * Omitted → auto-match on `id`/`uuid` from the payload. Bulk `*Many`
   * accept only a single-column selector for now (pass a 1-element array
   * or a bare string).
   */
  matchBy?: (keyof TEntity & string) | ReadonlyArray<keyof TEntity & string>;
};

/** Result summary of a bulk write (addMany/upsertMany/updateMany/deleteMany). */
export type BulkResult = {
  /** Rows received in the payload. */
  received: number;
  /**
   * Rows actually written, from PostgreSQL `rowCount` (inserted / upserted /
   * updated / deleted). `affected < received` is not an error for
   * upsert/update/delete — it reports unmatched or conflicted rows.
   */
  affected: number;
};

/** Bulk operation options (batch size, timeout). */
export type BulkOptions = {
  /** Batch size for temp table loading (default: auto-calculated from column count). */
  batchSize?: number;
  /**
   * Whole-operation wall-clock budget in ms for this bulk call — overrides
   * `DalConfig.bulkTimeoutMs`. Applied as `SET LOCAL statement_timeout`
   * (bounds each statement) plus a JS deadline checked between statements
   * (bounds the whole operation); on expiry the transaction rolls back and
   * a `BulkTimeoutError` is thrown.
   */
  timeoutMs?: number;
};

/** Upsert-specific options. */
export type UpsertOptions = {
  /** Conflict target column for upsert/upsertMany (defaults to the @Key() column). */
  conflictTarget?: string;
};

/**
 * Audit port — consumers inject their own audit writer.
 * The DAL calls `writeAudit` fire-and-forget (`.catch(logger?.error ?? noop)`).
 */
export interface AuditPort {
  writeAudit(params: AuditParams): Promise<void>;
}

/** Parameters passed to `AuditPort.writeAudit`. */
export type AuditParams = {
  entityClassName: string;
  tableName: string;
  entityId: bigint;
  entityUuid: string;
  action: AuditAction;
  changedAt: Date;
  version: number;
  changedBy: string;
  delta: Record<string, { old: unknown; new: unknown }>;
};

/** Audit action enum (mirrors BE's AuditAction). */
export enum AuditAction {
  INSERT = "INSERT",
  UPDATE = "UPDATE",
  SOFT_DELETE = "SOFT_DELETE",
  HARD_DELETE = "HARD_DELETE",
  RESTORE = "RESTORE",
}

/** Logger port — consumers inject their own logger. */
export interface LoggerPort {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
}
