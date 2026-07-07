/**
 * @primebrick/dal-pg — Type-driven PostgreSQL Data Access Layer for Primebrick v3.
 *
 * Public API:
 * - Entity decorators: @Entity, @Column, @Key, @Unique, @AuditableField, @DeletableField, etc.
 * - Repository: type-driven CRUD, finders, bulk ops with TEMP TABLE strategy.
 * - Query DSL: field, Filter, Sort, Join, Project.
 * - Errors: NotFoundError, MultipleRowsError, UnknownColumnError, ValidationError.
 * - Types: FindOptions, WriteOptions, BulkOptions, AuditPort, LoggerPort.
 * - Streaming: createStream for large result sets.
 * - Audit: buildAuditableJoins, auditable types.
 * - Dal gateway: getDal() singleton, pool ownership, type-parser registration,
 *   best-practice pool defaults (statement_timeout, connectionTimeoutMillis),
 *   withClient for transactions and per-call timeout override.
 */

// Entity decorators + metadata
export {
  Entity,
  Column,
  Key,
  Unique,
  IsNotColumn,
  AuditableField,
  DeletableField,
  SynchronizableField,
  CloneField,
  AuditTrail,
  AuditableFieldType,
  DeletableFieldType,
  SynchronizableFieldType,
  isEntityClass,
  getTableName,
  getQualifiedTableName,
  getEntityName,
  getColumnName,
  getPrimaryKeyColumn,
  getEntityPersistenceMeta,
  listEntityPersistencePropertyKeys,
  syncImplicitEntityColumns,
  type EntityClass,
  type ColumnOptions,
  type KeyOptions,
  type EntityPersistenceMeta,
} from "./meta/entity-meta.js";

// Column PG<->JS coercion
export {
  columnHintsFromMetaColumn,
  effectivePgStorageType,
  isLogicalJsDateColumn,
  jsValueToPgParam,
  pgValueToJsValue,
  entityDateToApiIso,
  hydrateEntityDateFieldsFromJson,
  type ColumnPgPersistenceHints,
} from "./meta/column-pg-io.js";

// Query DSL
export {
  field,
  Filter,
  Sort,
  Join,
  Project,
  type SqlOperator,
  type SqlSortDirection,
  type SqlJoinType,
  type SqlExpressionOperand,
  type FieldRef,
  type FilterExpr,
  type SortingExpr,
  type JoinExpr,
  type FieldProjector,
} from "./query/dsl.js";

// Query builder
export {
  buildSelectQuery,
  quoteIdent,
  type SqlQuery,
  type SelectQueryInput,
} from "./query/query-builder.js";

// Streaming
export { createStream } from "./query/streaming.js";

// Repository
export { Repository } from "./repository/repository.js";

// Errors
export {
  DalError,
  NotFoundError,
  MultipleRowsError,
  UnknownColumnError,
  ValidationError,
} from "./errors/errors.js";

// Types
export {
  type WithDeletedRecords,
  type FindByIdOptions,
  type FindOptions,
  type FindByUUIDOptions,
  type PaginatedEntity,
  type WriteOptions,
  type AuditableWriteOptions,
  type MatchByOptions,
  type BulkOptions,
  type UpsertOptions,
  type AuditPort,
  type AuditParams,
  type LoggerPort,
  AuditAction,
} from "./types/types.js";

// Entity interfaces
export {
  type IExposableEntity,
  type IDeletableEntity,
  type IAuditableEntity,
  type IClonableEntity,
} from "./types/entities.js";

// Audit helpers
export {
  buildAuditableJoins,
  buildAuditableJoinsSelective,
} from "./audit/auditable-joins.js";

export {
  type WithAuditableDisplayNames,
  type WithCreatorDisplayName,
  type WithUpdaterDisplayName,
} from "./audit/auditable-types.js";

// Dal gateway — high-level pool-owning singleton with best-practice defaults
export {
  Dal,
  getDal,
  resetDal,
  type DalConfig,
  type WithClientOptions,
} from "./dal/dal.js";
