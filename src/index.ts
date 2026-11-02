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

// Schema-diff + migration generation machinery (entity intent vs database catalog)
export * from "./schema-diff/index.js";

// Migration engine (runtime apply, registry, provenance manifest, drift check)
export * from "./migrations/index.js";

// Schema sovereignty domain (declared DATABASE_SCHEMA set + guards)
export {
  configureSchemaDomain,
  resetSchemaDomain,
  getSchemaDomain,
  resolveEntitySchema,
  SchemaDomainViolationError,
  type SchemaDomain,
} from "./meta/schema-domain.js";
export { assertEntitySchemaDomain } from "./meta/schema-domain-assert.js";

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
  AuditTrailEntity,
  PartitionField,
  PartitionChildOf,
  Index,
  ForeignKey,
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
  type UniqueOptions,
  type PartitionFieldOptions,
  type PartitionChildOfOptions,
  type IndexOptions,
  type IndexMethod,
  type ForeignKeyOptions,
  type ForeignKeyAction,
  type EntityPersistenceMeta,
  withColumnConstraints,
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
  GroupBy,
  type SqlOperator,
  type SqlSortDirection,
  type SqlJoinType,
  type SqlExpressionOperand,
  type FieldRef,
  type FilterExpr,
  type ExprOperand,
  type SortingExpr,
  type GroupByOperand,
  type JoinExpr,
  type FieldProjector,
} from "./query/dsl.js";

// List filters (canonical HTTP /list conditions -> FilterExpr)
export {
  translateFilterConditions,
  type ListFilterCondition,
  type ListFilterOptions,
} from "./query/list-filters.js";

// Query builder
export {
  buildSelectQuery,
  buildVectorSearchQuery,
  quoteIdent,
  type SqlQuery,
  type SelectQueryInput,
  type VectorHybridInput,
} from "./query/query-builder.js";

// Streaming
export { createStream } from "./query/streaming.js";

// Repository
export { Repository } from "./repository/repository.js";
// runInTransaction removed — it handed out a raw PoolClient. Transactions go
// through `dal.transaction(txRepo => …)` (tx-scoped Repository) or
// `dal.beginTransaction()` (single-statement CTE).

// Deferred fluent transaction — `dal.beginTransaction()` buffers repo ops and
// `commit()` runs them as ONE data-modifying CTE statement.
export {
  Deferred,
  DeferredFieldRef,
  DeferredTransaction,
} from "./dal/deferred-transaction.js";

// Errors
export {
  DalError,
  NotFoundError,
  MultipleRowsError,
  UnknownColumnError,
  ValidationError,
  MissingVersionError,
  RecordVanishedError,
  OptimisticLockError,
  DuplicateRecordError,
  DeletedRecordConflictError,
  BulkTimeoutError,
} from "./errors/errors.js";

// Error codes (optimistic concurrency control)
export { DalErrorCodes, type DalErrorCode } from "./errors/error-codes.js";

// Types
export {
  type WithDeletedRecords,
  type FindByIdOptions,
  type FindOptions,
  type FindByUUIDOptions,
  type PaginatedEntity,
  type WriteOptions,
  type AuditableWriteOptions,
  type OnConflictMode,
  type BulkResult,
  type MatchByOptions,
  type BulkOptions,
  type UpsertOptions,
  type VectorSearchOptions,
  type VectorDistanceOp,
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
  buildAuditTrailJoins,
} from "./audit/auditable-joins.js";

export {
  type WithAuditableDisplayNames,
  type WithCreatorDisplayName,
  type WithUpdaterDisplayName,
} from "./audit/auditable-types.js";

export { calculateDelta, calculateDeltaWithForcedFields } from "./audit/delta-calculator.js";

export { AuditLogEntity } from "./audit/audit-log-entity.js";
export { UserProfileRefEntity } from "./entities/user-profile-ref-entity.js";
export { isAuditableEntity } from "./repository/repository.js";

// Entity capability mixins — declare shared audit/deletable columns once,
// compose per-entity: `class E extends Deletable(Auditable(EntityBase))`
export {
  EntityBase,
  Auditable,
  Deletable,
  type EntityCtor,
} from "./entities/entity-base.js";

// Config entity base — standard dictionary-style config table entity
export { ConfigEntityBase } from "./entities/config-entity-base.js";

// Translation entity base — standard i18n translations table entity
export { TranslationEntityBase } from "./entities/translation-entity-base.js";

// Dal gateway — high-level pool-owning singleton with best-practice defaults
export {
  Dal,
  getDal,
  resetDal,
  type DalConfig,
  type TimeoutOverrideOptions,
} from "./dal/dal.js";

// Partition maintenance — metadata-driven pg_partman retention executor
export {
  runPartitionMaintenance,
  type PartitionMaintenanceReport,
  type PartitionParentReport,
} from "./dal/partition-maintenance.js";

// Generic entity CRUD service — the shared makeEntityService used by every
// service that owns entities (BE and microservices alike).
export {
  makeEntityService,
  makeTableAuditPort,
  type EntityService,
  type EntityServiceConfig,
  type EntityListQuery,
  type EntityListResult,
  type EntityAction,
  type BulkItem,
  type DuplicateResult,
  type AggregateDecl,
} from "./entity/entity-service.js";

// DomainService — the base class every worker service extends (owns one
// entity's persistence + business logic; data access via this.dal only).
export { DomainService } from "./entity/domain-service.js";
export {
  findAuditPage,
  type AuditPageOptions,
  type AuditPageResult,
  type AuditRow,
} from "./entity/audit-query.js";

// ── Guarded column types ─────────────────────────────────────────────────────
// Entity-annotation → storage type contract. `UUID`/`ISODate`/`ISOTime` are
// compile-time brands (zero runtime cost); `Vector`/`Decimal` are real classes
// the DAL recognises by `instanceof` on the io boundary.
export { type UUID, isUUID, toUUID, trustedUUID } from "./types/uuid.js";
export {
  type ISODate,
  type ISOTime,
  isISODate,
  toISODate,
  trustedISODate,
  isoDateFromUTCDate,
  isISOTime,
  toISOTime,
  trustedISOTime,
} from "./types/iso-datetime.js";
export { Vector } from "./types/vector.js";
export { type PgScalarType, type PgColumnType } from "./types/pg-column-type.js";

// ── Decimal — base-10 exact arithmetic (`numeric` columns) ───────────────────
// Re-exported so entity/service code only needs `@primebrick/dal-pg`.
export {
  Decimal,
  dec,
  isDecimal,
  isPeriodic,
  fromPG as decimalFromPG,
  toPG as decimalToPG,
} from "@primebrick/core/decimal";

// Canonical shared contracts (entity meta schema, actions vocabulary, list
// query types) — re-exported so consumers get them through this package.
export * from "@primebrick/core";

// ── Static annotation extraction (schema pipeline — primebrick-db) ───────────
export {
  extractEntityAnnotations,
  lookupEntityAnnotation,
  type EntityAnnotationMap,
  type EntityAnnotationInfo,
} from "./meta/entity-annotation-extract.js";
export {
  resolvePgTypeForSchema,
  pgTypeFromAnnotation,
  canonicalPgType,
  assertPgTypeCompatible,
  columnTypeWarnings,
  type EntityColumnTypeHints,
  type EntityTypeWarning,
} from "./meta/entity-ts-to-pg.js";
