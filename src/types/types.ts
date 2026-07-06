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
  deletedRecords?: WithDeletedRecords;
  filters?: FilterExpr[];
  sorting?: SortingExpr[];
  joins?: JoinExpr[];
  /** When true, stream results via pg-query-stream instead of buffering. */
  stream?: boolean;
};

/** Options for `findByUUID`. */
export type FindByUUIDOptions = {
  throwIfNotFound?: boolean;
  deletedRecords?: WithDeletedRecords;
};

/** Paginated result wrapper. */
export type PaginatedEntity<TEntity> = {
  entities: TEntity[];
  total_records: number;
};

/** Options for write ops (add, upsert, update, delete, restore, hardDelete). */
export type WriteOptions = {
  /** The actor performing the operation (stamped into created_by/updated_by/deleted_by). */
  actor: string;
  /** Optional audit port — if not injected, audit is silently skipped. */
  audit?: AuditPort;
  /** Optional logger port — if not injected, errors are swallowed. */
  logger?: LoggerPort;
};

/** Options for bulk ops (addMany, upsertMany, deleteMany, updateMany). */
export type BulkOptions = WriteOptions & {
  /** Conflict target column for upsertMany (defaults to "uuid"). */
  conflictTarget?: string;
  /** Batch size for temp table loading (default: auto-calculated from column count). */
  batchSize?: number;
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
  entityId: number;
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
