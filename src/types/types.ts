/**
 * Public DAL types — options, ports, paginated results.
 *
 * The DAL uses **ports** (interfaces) for audit and logging so consumers can
 * inject their own implementations. If no port is injected, the DAL silently
 * skips audit/logging — microservices that don't need it aren't forced to
 * implement it.
 */

import type { FilterExpr, SortingExpr, JoinExpr } from "../query/dsl.js";

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

/** Base write options — no actor (for non-auditable entities). */
export type WriteOptions = {
  /** Optional audit port — if not injected, audit is silently skipped. */
  audit?: AuditPort;
  /** Optional logger port — if not injected, errors are swallowed. */
  logger?: LoggerPort;
  /** Override the table name (e.g., for audit trail tables: "customers_audit"). */
  tableName?: string;
};

/** Write options for auditable entities — actor is required. */
export type AuditableWriteOptions = WriteOptions & {
  /** The actor performing the operation (stamped into created_by/updated_by/deleted_by). */
  actor: string;
};

/** Options for match-by operations (update, delete, restore, hardDelete). */
export type MatchByOptions<TEntity> = {
  /**
   * Which entity property to use as the WHERE left operand.
   * Defaults to the @Key() column.
   * TypeScript guardrail: only accepts actual properties of TEntity.
   */
  matchBy?: keyof TEntity & string;
};

/** Bulk operation options (batch size, timeout). */
export type BulkOptions = {
  /** Batch size for temp table loading (default: auto-calculated from column count). */
  batchSize?: number;
  /** Per-statement timeout in ms. */
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
