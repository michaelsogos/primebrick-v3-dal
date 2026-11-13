import "reflect-metadata";

import type { DictFacet } from "@primebrick/core";

import { inferPgTypeFromEntityColumn, type JsType } from "./entity-ts-to-pg.js";
import type { PgColumnType } from "../types/pg-column-type.js";
import { getSchemaDomain, resolveEntitySchema } from "./schema-domain.js";

/**
 * Entity metadata via legacy TypeScript decorators (WeakMap "reflection").
 *
 * **Convention:** every "data" property on the class `prototype` is a SQL column
 * with a name equal to the property name (snake_case). `@Column()` is only needed
 * for: `sqlName` / `pgType` / `nullable`, or a short alias for the column name.
 *
 * - `@Entity()` — table name; optional argument if different from class name.
 * - `@Key()` — primary key (one column only).
 * - `@Unique()` — unique index (DDL patch).
 * - `@IsNotColumn()` — excludes the property from persistence meta & DAL queries.
 * - `@AuditableField(type)` — marks a field as audit (created_at, created_by, etc.).
 * - `@DeletableField(type)` — marks a field as soft-delete (deleted_at, deleted_by).
 * - `@CloneField()` — marks a field as clone tracking (cloned_from).
 * - `@AuditTrail()` — marks the entity as having an audit trail table.
 */

export type EntityClass = abstract new (...args: any[]) => object;

export enum AuditableFieldType {
  CREATED_AT = "CREATED_AT",
  CREATED_BY = "CREATED_BY",
  UPDATED_AT = "UPDATED_AT",
  UPDATED_BY = "UPDATED_BY",
  VERSION = "VERSION",
}

export enum DeletableFieldType {
  DELETED_AT = "DELETED_AT",
  DELETED_BY = "DELETED_BY",
}

export enum SynchronizableFieldType {
  LAST_SYNCED_AT = "LAST_SYNCED_AT",
}

export enum CloneFieldType {
  /** Source-record pointer (`cloned_from` — uuid of the record this one
   *  was cloned from; self-ref to the owning entity). */
  CLONED_FROM = "CLONED_FROM",
  /** Clone instant (`cloned_at` — timestamptz written at clone time). */
  CLONED_AT = "CLONED_AT",
  /** Clone actor (`cloned_by` — user_profile ref written at clone time). */
  CLONED_BY = "CLONED_BY",
}

export type IndexMethod = "btree" | "hash" | "gin" | "gist" | "spgist" | "brin" | "hnsw";

/** Options for `@Index()` — plain (non-unique) secondary indexes of any PG access method. */
export type IndexOptions = {
  /**
   * Index name. Columns sharing the same `name` form a composite index,
   * ordered by `order` (ascending). Omitted → single-column index
   * auto-named `<table>_<column>_idx`.
   */
  name?: string;
  /** Order within a composite index (default 0). Only meaningful with `name`. */
  order?: number;
  /** PG access method. Default `btree`. */
  using?: IndexMethod;
  /** Operator class (e.g. `vector_cosine_ops` for hnsw, `gin_trgm_ops` for gin). */
  opclass?: string;
  /** Partial-index predicate (raw SQL, e.g. `deleted_at IS NULL`). */
  where?: string;
};

export type ForeignKeyAction = "restrict" | "cascade" | "set_null" | "set_default" | "no_action";

/** Options for `@ForeignKey()` — REFERENCES target entity column. */
export type ForeignKeyOptions = {
  /** Referenced column on the target entity — default: the target's `@Key()` column. */
  column?: string;
  /** ON DELETE action — default `restrict` (fail-fast, cannot be deferred). */
  onDelete?: ForeignKeyAction;
  /** ON UPDATE action — default `no_action`. */
  onUpdate?: ForeignKeyAction;
  /** Constraint name override — default `<table>_<column>_fkey`. */
  name?: string;
};

type ColumnRegistration = {
  sqlName: string;
  isKey: boolean;
  isUnique: boolean;
  /** `@Index()` — secondary index declaration */
  indexOpts?: IndexOptions;
  /** `@ForeignKey()` — REFERENCES declaration (lazy target thunk for circular deps) */
  foreignKey?: { target: () => EntityClass; opts: ForeignKeyOptions };
  /** `@PartitionField()` — this column is the RANGE partition key of the table */
  isPartition?: boolean;
  partitionOpts?: PartitionFieldOptions;
  /** Composite unique index name — columns sharing the same name form a composite unique index. */
  uniqueIndexName?: string;
  /** Order priority within a composite unique index (0-based). Lower = first in index. */
  uniqueIndexOrder?: number;
  /** `@Unique(…, {nullsNotDistinct})` — composite unique treats NULLs as equal (PG15+). */
  uniqueNullsNotDistinct?: boolean;
  nullable?: boolean;
  pgType?: string;
  /** For varchar/char/bit varying etc. */
  length?: number;
  /** For numeric/decimal */
  precision?: number;
  scale?: number;
  /** SQL DEFAULT expression (raw, e.g. `now()` or `gen_random_uuid()`) */
  defaultSql?: string;
  /** Key generation strategy; default = identity for @Key() */
  keyGenerated?: "identity" | "manual";
  /**
   * Runtime hydration hint for JSON round-trips (cache / wire revive):
   * - `"instant"` → ISO string → `Date`
   * - `"decimal"` → `"N.Nd"` string → `Decimal`
   * - `"vector"`  → array/`"[…]"` → `Vector`
   * - `"bigint"`  → number/`"N"` → `bigint`
   * - `SomeClass` → jsonb payload revives to a real class instance
   *   (`cls.fromJson(v)` when exposed, else prototype graft; element-wise
   *   for array props) — the ctor IS the runtime JS type, same channel.
   * Also pins storage (`instant`→timestamptz, `decimal`→numeric,
   * `vector`→vector, `bigint`→int8, `Ctor`→jsonb) — it is the runtime-visible
   * counterpart of the erased TS annotation.
   * DB reads never need this — pg parsers return the right shape by OID.
   * Required (lint) on `Decimal`, `Vector`, `bigint`, and non-audit
   * `Date` props.
   */
  jsType?: JsType;
  /** Auditable field metadata */
  isAuditable?: boolean;
  auditableType?: AuditableFieldType;
  /** Deletable field metadata */
  isDeletable?: boolean;
  deletableType?: DeletableFieldType;
  /** Synchronizable field metadata */
  isSynchronizable?: boolean;
  synchronizableType?: SynchronizableFieldType;
  /** Clone field metadata */
  isClone?: boolean;
  cloneType?: CloneFieldType;
  /** `@Ref("entity_name")` — the column's value identifies a record of that
   *  entity (served-meta ref contract: `type:"ref"` + `ref.entity`). Meta-
   *  only — no DDL FK is emitted; the target may live in another schema's
   *  domain (e.g. `user_profile`). For same-schema physical FKs use
   *  `@ForeignKey` — which does NOT imply a display ref. */
  refEntity?: string;
  /** Cast type to apply when this field is used in JOIN ON clause */
  castInJoin?: string;
};

/**
 * Closed vocabulary of accepted SQL DEFAULT expressions for generated
 * uuid columns. The enum member's value IS the emitted SQL — declaring
 * `default` guarantees the patch carries the right expression; anything
 * else is a declaration-time type error, never a runtime surprise.
 * (For non-uuid columns `defaultSql` remains the raw escape hatch.)
 */
export enum ColumnDefault {
  /** `gen_random_uuid()` — pgcrypto uuid v4. */
  UUID_V4_DEFAULT_GENERATED = "gen_random_uuid()",
  /** `uuidv7()` — native PG18 time-ordered uuid v7 (canonical for PKs). */
  UUID_V7_DEFAULT_GENERATED = "uuidv7()",
}

export type ColumnOptions = {
  sqlName?: string;
  /**
   * PostgreSQL storage type override for DDL + io. Canonical names only
   * (`PgColumnType` union) — aliases are compile errors; modifiers come from
   * `length`/`precision`/`scale`, never from the string.
   * Omit when the annotation already implies the right type
   * (`UUID`→uuid, `Date`→timestamptz, `bigint`→int8, …).
   */
  pgType?: PgColumnType;
  /** `varchar(N)` on string props, `vector(N)` on `Vector` props. */
  length?: number;
  /** `numeric(p,s)` on `Decimal` props. */
  precision?: number;
  scale?: number;
  nullable?: boolean;
  /** SQL DEFAULT expression (raw). Mutually exclusive with `default`. */
  defaultSql?: string;
  /** Closed-set DEFAULT for uuid columns — see {@link ColumnDefault}. */
  default?: ColumnDefault;
  /** Runtime hydration hint for JSON round-trips — see `ColumnRegistration.jsType`. */
  jsType?: JsType;
  /** Cast type to apply when this field is used in JOIN ON clause (e.g., 'uuid') */
  castInJoin?: string;
};

type CalculatedRegistration = {
  /** Result alias — defaults to the property key. */
  sqlName: string;
  /** Scalar SQL expression (correlated subquery, CASE, arithmetic, …).
   *  `{self}` inside the string is replaced with the qualified base-table
   *  ref (`"schema"."table"`) at render time — correlation-safe across
   *  schema overrides and table-name overrides. */
  expr: string;
  /** Declared SQL result type of `expr` ("int4", "timestamptz", …) — same
   *  contract as `@Column({ pgType })`: the TS annotation is erased at
   *  transpile, so the runtime type must be declared. Drives meta `type`/
   *  `pg_type` derivation and read-path hydration hints. */
  pgType?: string;
  /** Whether `expr` can evaluate to NULL — projected presence is never
   *  guaranteed (write paths don't project calculated props), so `?` on
   *  the annotation means "may be absent"; THIS flag is the NULL-value
   *  declaration feeding meta `nullable`. */
  nullable?: boolean;
};

type ClassEntityMeta = {
  tableName?: string;
  /** Optional schema override — if set, takes precedence over the Dal's default schema. */
  tableSchema?: string;
  columns: Map<PropertyKey, ColumnRegistration>;
  /** `@Calculated()` — SQL-projected expressions. Never physical columns:
   *  excluded from DDL/insert/update; injected as `Project.expr` on read. */
  calculated: Map<PropertyKey, CalculatedRegistration>;
  /** `@IsNotColumn()` — excluded from persistence meta & future DAL builders */
  notColumnKeys: Set<PropertyKey>;
  /** `@AuditTrail()` — entity has audit trail table */
  isAuditable?: boolean;
  /** `@AuditTrailEntity()` — entity IS an audit trail table (read-only audit log) */
  isAuditTrailEntity?: boolean;
  /** Column name used for the `changed_by` field in audit trail entities */
  auditTrailChangedByColumn?: string;
  /** `@PartitionChildOf()` — this entity is a logical child of a partitioned
   *  parent: it participates in the parent's atomic delete + retention purge. */
  partitionChildOf?: PartitionChildOfOptions;
  /** `@Dict()` — the entity is a dictionary/enum surface: the served meta
   *  carries the `dict` facet and nav derives `kind:"dict"` routes. Set on a
   *  shared base (e.g. DictEntityBase), inherited via collectMetaChain;
   *  redeclaring on the concrete class replaces the facet wholesale. */
  dict?: DictFacet;
};

/** Options for `@PartitionField()` — the RANGE partition key declaration. */
export type PartitionFieldOptions = {
  /** pg_partman interval, e.g. "1 month" (default), "1 day", "1 week". */
  interval?: string;
  /** pg_partman retention, e.g. "6 months". Undefined = no auto-retention. */
  retention?: string;
  /** partman retention_keep_table — false = DROP (default), true = detach. */
  keepTable?: boolean;
  /** partman premake (future partitions kept ahead). Default: partman's. */
  premake?: number;
};

/** Options for `@PartitionChildOf()` — declares membership in a partitioned
 *  parent's atomic delete/retention unit. */
export type PartitionChildOfOptions = {
  /** The partitioned parent entity class. */
  parent: EntityClass;
  /** This entity's column referencing the parent (e.g. "conversation_uuid"). */
  ref: string;
  /** The parent's referenced column — default "uuid". */
  parentRef?: string;
};

const META = new WeakMap<Function, ClassEntityMeta>();

function ensureMeta(ctor: Function): ClassEntityMeta {
  let m = META.get(ctor);
  if (!m) {
    m = { columns: new Map(), calculated: new Map(), notColumnKeys: new Set() };
    META.set(ctor, m);
  }
  return m;
}

function touchColumn(ctor: Function, key: PropertyKey): ColumnRegistration {
  const m = ensureMeta(ctor);
  let c = m.columns.get(key);
  if (!c) {
    c = { sqlName: String(key), isKey: false, isUnique: false };
    m.columns.set(key, c);
  }
  return c;
}

/** Data property names on a default instance (`new ctor()`), i.e. own enumerable props. */
function discoverInstancePropertyKeys(ctor: Function): string[] {
  const inst = new (ctor as any)();
  return Object.keys(inst);
}

/**
 * Walk the prototype chain of `ctor` and collect every ClassEntityMeta
 * registered by decorators, parent-first (subclass last → wins on conflicts).
 * Field decorators (@Column, @Key, @AuditableField, …) register on the
 * DECLARING class (e.g. a shared entity base), while @Entity(schema) lives on
 * the concrete subclass — inheritance must be resolved explicitly because
 * META is keyed by constructor.
 */
function collectMetaChain(ctor: Function): ClassEntityMeta[] {
  const chain: ClassEntityMeta[] = [];
  for (
    let p = ctor;
    p && p !== Function.prototype && p !== Object;
    p = Object.getPrototypeOf(p)
  ) {
    const m = META.get(p);
    if (m) {
      // Ensure implicit (non-decorated) columns on ancestors are synced too —
      // the parent's own meta may never have been through getEntityPersistenceMeta.
      syncImplicitEntityColumns(p);
      chain.unshift(m);
    }
  }
  return chain;
}

/** True when an ancestor class already has a registration for `key`. */
function hasInheritedColumnRegistration(ctor: Function, key: PropertyKey): boolean {
  for (
    let p = Object.getPrototypeOf(ctor);
    p && p !== Function.prototype && p !== Object;
    p = Object.getPrototypeOf(p)
  ) {
    if (META.get(p)?.columns.has(key)) return true;
  }
  return false;
}

/**
 * Merged column registrations for `ctor` across the prototype chain —
 * parent-first, subclass wins on conflicts.
 */
function collectEntityColumnRegistrations(
  ctor: Function,
): Map<PropertyKey, ColumnRegistration> {
  const merged = new Map<PropertyKey, ColumnRegistration>();
  for (const m of collectMetaChain(ctor)) {
    for (const [propKey, reg] of m.columns) merged.set(propKey, reg);
  }
  return merged;
}

/** Merged `@Calculated` registrations across the prototype chain — same
 *  parent-first/subclass-wins semantics as physical columns. */
function collectCalculatedRegistrations(
  ctor: Function,
): Map<PropertyKey, CalculatedRegistration> {
  const merged = new Map<PropertyKey, CalculatedRegistration>();
  for (const m of collectMetaChain(ctor)) {
    for (const [propKey, reg] of m.calculated) merged.set(propKey, reg);
  }
  return merged;
}

/** Registers every implicit column + `design:type` / nullability when not already set by decorators. */
export function syncImplicitEntityColumns(ctor: Function): void {
  const m = META.get(ctor);
  if (!m?.tableName) return;
  const discovered = discoverInstancePropertyKeys(ctor);
  const decorated = [...m.columns.keys()].map((k) => String(k));
  const keys = [...new Set([...discovered, ...decorated])];

  for (const name of keys) {
    const key = name as PropertyKey;
    const metaKey = name as string | symbol;
    if (m.notColumnKeys.has(key)) continue;
    // Skip properties already decorated on an ancestor: their registration
    // (with @Column/@Key/@AuditableField flags) is inherited via the
    // prototype-chain merge in getEntityPersistenceMeta — creating a fresh
    // bare registration here would shadow the decorated one on merge.
    if (hasInheritedColumnRegistration(ctor, key)) continue;
    if (hasInheritedCalculatedRegistration(ctor, key)) continue;
    touchColumn(ctor, key);
  }
}

/** True when an ancestor class already has a `@Calculated` registration for `key`. */
function hasInheritedCalculatedRegistration(ctor: Function, key: PropertyKey): boolean {
  for (
    let p = Object.getPrototypeOf(ctor);
    p && p !== Function.prototype && p !== Object;
    p = Object.getPrototypeOf(p)
  ) {
    if (META.get(p)?.calculated.has(key)) return true;
  }
  return false;
}

/**
 * Maps the class to a DB table. Optional argument overrides the table name;
 * if omitted, the table name equals the class name.
 */
export function Entity(tableName?: string, schema?: string) {
  return function <T extends Function>(ctor: T): T {
    const m = ensureMeta(ctor);
    m.tableName = tableName ?? ctor.name;
    if (schema) m.tableSchema = schema;
    // Expose table name via standard Reflect API for external consumers (no import needed).
    // Used by the SDK's CacheKeyBuilder and any other tooling that needs the table name
    // without importing @primebrick/dal-pg.
    Reflect.defineMetadata("primebrick:tableName", m.tableName, ctor);
    return ctor;
  };
}

function assertNonEmptyColumnOptions(o: ColumnOptions): void {
  if (
    o.sqlName === undefined &&
    o.pgType === undefined &&
    o.length === undefined &&
    o.precision === undefined &&
    o.scale === undefined &&
    o.nullable === undefined &&
    o.defaultSql === undefined &&
    o.default === undefined &&
    o.jsType === undefined &&
    o.castInJoin === undefined
  ) {
    throw new TypeError(
      "@Column({ … }) requires at least one of: sqlName, pgType, length, precision/scale, nullable, defaultSql, default, jsType, castInJoin"
    );
  }
}

/** Override SQL name / `pgType` / `nullable` only; otherwise the property is already a column by convention. */
export function Column(sqlName: string): PropertyDecorator;
export function Column(opts: ColumnOptions): PropertyDecorator;
export function Column(sqlNameOrOpts: string | ColumnOptions): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol) {
    const ctor = (target as { constructor: Function }).constructor;
    const col = touchColumn(ctor, propertyKey);

    if (typeof sqlNameOrOpts === "string") {
      col.sqlName = sqlNameOrOpts;
    } else {
      assertNonEmptyColumnOptions(sqlNameOrOpts);
      if (sqlNameOrOpts.sqlName !== undefined) col.sqlName = sqlNameOrOpts.sqlName;
      if (sqlNameOrOpts.pgType !== undefined) col.pgType = sqlNameOrOpts.pgType;
      if (sqlNameOrOpts.length !== undefined) col.length = sqlNameOrOpts.length;
      if (sqlNameOrOpts.precision !== undefined) col.precision = sqlNameOrOpts.precision;
      if (sqlNameOrOpts.scale !== undefined) col.scale = sqlNameOrOpts.scale;
      if (sqlNameOrOpts.nullable !== undefined) col.nullable = sqlNameOrOpts.nullable;
      if (
        sqlNameOrOpts.default !== undefined &&
        sqlNameOrOpts.defaultSql !== undefined
      ) {
        throw new TypeError(
          "@Column({ … }): 'default' (ColumnDefault enum) and 'defaultSql' (raw) are mutually exclusive"
        );
      }
      if (sqlNameOrOpts.default !== undefined) col.defaultSql = sqlNameOrOpts.default;
      if (sqlNameOrOpts.defaultSql !== undefined) col.defaultSql = sqlNameOrOpts.defaultSql;
      if (sqlNameOrOpts.jsType !== undefined) col.jsType = sqlNameOrOpts.jsType;
      if (sqlNameOrOpts.castInJoin !== undefined) col.castInJoin = sqlNameOrOpts.castInJoin;
    }
  };
}

/** Options for `@Calculated()` — a SQL-projected read-only expression. */
export type CalculatedOptions = {
  /** Result alias — defaults to the property key. */
  sqlName?: string;
  /** Declared SQL result type of `expr` — e.g. `"int4"` for `count(*)::int`,
   *  `"timestamptz"` for `max(created_at)`. The annotation is erased at
   *  transpile; without it the column resolves `type:"text"` in meta and
   *  hydrates by driver default. */
  pgType?: string;
  /** `expr` may evaluate to NULL — declare it so meta `nullable` is honest.
   *  (`?` on the prop means "may be absent on non-read paths" — a different
   *  fact; both are legal together.) */
  nullable?: boolean;
};

/**
 * Marks a property as a calculated SQL projection — never a physical column.
 * The expression lives ONCE on the entity class; the DAL injects it as
 * `Project.expr` on every list/get and substitutes it into WHERE/ORDER BY,
 * so calculated columns are sortable/filterable like physical ones.
 * `expr` may reference the base table via the `{self}` token (rendered as
 * `"schema"."table"`); correlated subqueries must be scalar (≤1 row).
 */
export function Calculated(expr: string, opts?: CalculatedOptions): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol) {
    const ctor = (target as { constructor: Function }).constructor;
    const m = ensureMeta(ctor);
    // Never a physical column: block the implicit-column convention AND any
    // explicit registration — DDL can never create it.
    m.notColumnKeys.add(propertyKey);
    m.columns.delete(propertyKey);
    m.calculated.set(propertyKey, {
      sqlName: opts?.sqlName ?? String(propertyKey),
      expr,
      pgType: opts?.pgType,
      nullable: opts?.nullable,
    });
  };
}

/** Excludes the property from meta schema / migration and from future DAL queries. */
export function IsNotColumn(): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol) {
    const ctor = (target as { constructor: Function }).constructor;
    const m = ensureMeta(ctor);
    m.notColumnKeys.add(propertyKey);
    m.columns.delete(propertyKey);
  };
}

/** Unique constraint options for composite unique indexes. */
export type UniqueOptions = {
  /**
   * Composite unique index name. Columns sharing the same `indexName` form a
   * composite unique index, ordered by `orderPriority` (ascending).
   * If omitted, the column gets a single-column unique index (legacy behavior).
   */
  indexName?: string;
  /**
   * Order priority within a composite unique index (0-based).
   * Lower values come first in the index. Only meaningful when `indexName` is set.
   */
  orderPriority?: number;
  /** PG15+ `NULLS NOT DISTINCT` — NULL members of the unique group are
   *  treated as equal (they conflict instead of stacking). Declare on any
   *  member of the group; convention is the order-0 member. */
  nullsNotDistinct?: boolean;
};

/** Unique constraint (PostgreSQL: unique index in generated patches). */
export function Unique(): PropertyDecorator;
export function Unique(indexName: string, orderPriority: number, opts?: UniqueOptions): PropertyDecorator;
export function Unique(indexName?: string, orderPriority?: number, opts?: UniqueOptions): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol) {
    const ctor = (target as { constructor: Function }).constructor;
    const col = touchColumn(ctor, propertyKey);
    col.isUnique = true;
    // Unique columns default to NOT NULL, but an explicit
    // @Column({ nullable: true }) wins (e.g. composite uniques where a
    // member is genuinely nullable, like ai_models.dtype).
    if (col.nullable === undefined) col.nullable = false;
    const effName = indexName ?? opts?.indexName;
    const effOrder = orderPriority ?? opts?.orderPriority;
    if (effName !== undefined) {
      col.uniqueIndexName = effName;
      col.uniqueIndexOrder = effOrder ?? 0;
    }
    if (opts?.nullsNotDistinct !== undefined) col.uniqueNullsNotDistinct = opts.nullsNotDistinct;

  };
}

export type KeyOptions = {
  /** default = 'identity' */
  generated?: "identity" | "manual";
  /** SQL DEFAULT expression (raw). Only used when `generated: 'manual'` or non-identity key. */
  defaultSql?: string;
};

/** Marks the single-column primary key. */
export function Key(): PropertyDecorator;
export function Key(opts: KeyOptions): PropertyDecorator;
export function Key(opts?: KeyOptions): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol) {
    const ctor = (target as { constructor: Function }).constructor;
    const col = touchColumn(ctor, propertyKey);
    col.isKey = true;
    col.nullable = false;
    col.keyGenerated = opts?.generated ?? col.keyGenerated ?? "identity";
    if (opts?.defaultSql !== undefined) col.defaultSql = opts.defaultSql;

    // Expose key column via standard Reflect API for external consumers (no import needed).
    // Used by the SDK's CacheKeyBuilder as the pkey fallback when no @CacheKey() and no uuid.
    Reflect.defineMetadata(
      "primebrick:keyColumn",
      { propertyKey: String(propertyKey), sqlName: col.sqlName },
      ctor,
    );
  };
}

/** Marks a field as auditable (created_at, created_by, updated_at, updated_by, version). */
export function AuditableField(what: AuditableFieldType): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol) {
    const ctor = (target as { constructor: Function }).constructor;
    const col = touchColumn(ctor, propertyKey);
    col.isAuditable = true;
    col.auditableType = what;

  };
}

/** Marks a field as deletable (deleted_at, deleted_by). */
export function DeletableField(what: DeletableFieldType): PropertyDecorator;
export function DeletableField(): PropertyDecorator;
export function DeletableField(what?: DeletableFieldType): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol) {
    const ctor = (target as { constructor: Function }).constructor;
    const col = touchColumn(ctor, propertyKey);
    col.isDeletable = true;
    col.deletableType = what ?? DeletableFieldType.DELETED_AT;
    col.nullable = true;

  };
}

/** Marks a field as synchronizable (last_synced_at). */
export function SynchronizableField(what: SynchronizableFieldType): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol) {
    const ctor = (target as { constructor: Function }).constructor;
    const col = touchColumn(ctor, propertyKey);
    col.isSynchronizable = true;
    col.synchronizableType = what;

  };
}

/** Marks a field as clone tracking. `@CloneField()` defaults to
 *  `CLONED_FROM` — the single source-record pointer (`isClone`, exactly
 *  one per entity). `CLONED_AT`/`CLONED_BY` mark the immutable
 *  clone-audit columns the write path populates at clone time. */
export function CloneField(what?: CloneFieldType): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol) {
    const ctor = (target as { constructor: Function }).constructor;
    const col = touchColumn(ctor, propertyKey);
    const type = what ?? CloneFieldType.CLONED_FROM;
    col.cloneType = type;
    col.nullable = true;
    if (type === CloneFieldType.CLONED_FROM) col.isClone = true;

  };
}

/** Declares a served-meta reference: the column's value is the uid (uuid)
 *  of a record in the named entity — the single source of truth behind
 *  `type:"ref"` + `ref.entity` on the served column. Applied once on the
 *  `Auditable`/`Deletable` mixin's `*_by` actor columns it is inherited by
 *  every entity; it is also the declaration path for domain FK display
 *  refs (replacing authored `ref:` in list-configs). */
export function Ref(entity: string): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol) {
    const ctor = (target as { constructor: Function }).constructor;
    touchColumn(ctor, propertyKey).refEntity = entity;
  };
}

/** Marks an entity as having an audit trail table. */
export function AuditTrail(): ClassDecorator {
  return function <T extends Function>(target: T): T {
    const m = ensureMeta(target);
    m.isAuditable = true;
    return target;
  };
}

/**
 * Marks a class as BEING an audit trail entity (e.g., AuditLogEntity).
 * Distinct from @AuditTrail() which marks an entity as HAVING an audit trail.
 * The changedByColumn specifies which property holds the actor (default: "changed_by").
 */
export function AuditTrailEntity(options?: { changedByColumn?: string }): ClassDecorator {
  return function <T extends Function>(target: T): T {
    const m = ensureMeta(target);
    m.isAuditTrailEntity = true;
    m.auditTrailChangedByColumn = options?.changedByColumn ?? "changed_by";
    return target;
  };
}

/**
 * Marks a column as the RANGE partition key of the table (pg_partman,
 * monthly/daily/…). Exactly ONE per entity. The column must be NOT NULL and
 * date/timestamptz-typed; every unique group and the primary key emitted in
 * DDL must include it (PostgreSQL requirement) — `getEntityPersistenceMeta`
 * validates this and throws otherwise, so a partitioned entity can never
 * produce an invalid table definition.
 */
export function PartitionField(opts?: PartitionFieldOptions): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol) {
    const ctor = (target as { constructor: Function }).constructor;
    const col = touchColumn(ctor, propertyKey);
    col.isPartition = true;
    col.partitionOpts = opts ?? {};
    // A partition key must be NOT NULL — a NULL would not fall into any
    // RANGE partition. Explicit @Column({nullable:true}) is overridden:
    // partitioning semantics win.
    col.nullable = false;

  };
}

/**
 * Declares a secondary (non-unique) index. Bare `@Index()` → single-column
 * btree auto-named `<table>_<col>_idx`. Same `name` on multiple columns →
 * composite index ordered by `order`. Supports every PG access method:
 * `@Index({ using: 'hnsw', opclass: 'vector_cosine_ops' })`,
 * `@Index({ where: 'deleted_at IS NULL' })` for partial indexes.
 * Unique indexes stay on `@Unique()`.
 */
export function Index(): PropertyDecorator;
export function Index(opts: IndexOptions): PropertyDecorator;
export function Index(opts?: IndexOptions): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol) {
    const ctor = (target as { constructor: Function }).constructor;
    const col = touchColumn(ctor, propertyKey);
    col.indexOpts = opts ?? {};

  };
}

/**
 * Declares a FOREIGN KEY constraint referencing another entity's column.
 * `target` is a lazy thunk (`() => CustomerEntity`) so circular entity
 * references resolve at meta-read time, not class-eval time.
 * Minimal form `@ForeignKey(() => CustomerEntity)` references the target's
 * `@Key()` column with `ON DELETE RESTRICT` / `ON UPDATE NO ACTION` —
 * the zero-option path is the safest behavior.
 * Note: a partitioned parent (`@PartitionField`) cannot be a plain FK target
 * unless the referenced unique constraint includes the partition key —
 * meta validation throws and points to `@PartitionChildOf` for that shape.
 */
export function ForeignKey(target: () => EntityClass, opts?: ForeignKeyOptions): PropertyDecorator {
  return function (t: object, propertyKey: string | symbol) {
    const ctor = (t as { constructor: Function }).constructor;
    const col = touchColumn(ctor, propertyKey);
    col.foreignKey = { target, opts: opts ?? {} };
  };
}

/**
 * Declares this entity a logical child of a `@PartitionField`-partitioned
 * parent: it joins the parent's atomic delete and retention purge unit.
 * Needed because a partitioned parent cannot host a plain FOREIGN KEY
 * (unique constraints must contain the partition key) — the relationship
 * is application-level, enforced by the repository cascade and the
 * partition-maintenance purge. Entities that merely REFERENCE a parent
 * (telemetry, logs) simply don't declare this.
 */
export function PartitionChildOf(opts: PartitionChildOfOptions): ClassDecorator {
  return function <T extends Function>(target: T): T {
    const m = ensureMeta(target);
    m.partitionChildOf = opts;
    return target;
  };
}

/**
 * Marks an entity as a dictionary/enum surface — typically set ONCE on a
 * shared base class (e.g. DictEntityBase) so every subclass inherits the
 * marker through collectMetaChain. `opts` becomes the served meta `dict`
 * facet; redeclaring on a concrete class replaces it wholesale.
 */
export function Dict(opts?: DictFacet): ClassDecorator {
  return function <T extends Function>(target: T): T {
    const m = ensureMeta(target);
    m.dict = opts ?? {};
    return target;
  };
}

/**
 * The entity's resolved `dict` facet — subclass-first walk of the meta
 * chain (same precedence as every class-level flag). `undefined` when no
 * ancestor carries `@Dict()`.
 */
export function getDictFacet(ctor: EntityClass): DictFacet | undefined {
  for (
    let p = ctor as Function;
    p && p !== Function.prototype && p !== Object;
    p = Object.getPrototypeOf(p)
  ) {
    const d = META.get(p)?.dict;
    if (d !== undefined) return d;
  }
  return undefined;
}

export function isEntityClass(value: unknown): value is EntityClass {
  return typeof value === "function" && META.get(value as Function)?.tableName !== undefined;
}

/**
 * Capability probes — the entity class is the only source of truth for
 * what a service can do. The SDK cannot inspect decorators, so services
 * expose these through the `EntityServiceLike` facet contract (same
 * pattern as `DomainService.dictFacet`) and consumers never restate them.
 */

/** `true` when the entity class carries `@AuditTrail()` — i.e. it HAS an
 *  audit-trail table. Distinct from column-level `@AuditableField`, which
 *  only marks write-path-stamped columns. Named `hasAuditTrail` so it
 *  never collides with the meta-level `isAuditableEntity` probe. */
export function hasAuditTrail(ctor: EntityClass): boolean {
  return getEntityPersistenceMeta(ctor).isAuditable === true;
}

/** `true` when the entity class declares a `@CloneField` column — the
 *  `Clonable` mixin's `cloned_from`. Entities without it must not expose
 *  `/duplicate`: a clone with no tracking columns writes an untracked copy. */
export function isClonableEntity(ctor: EntityClass): boolean {
  const meta = getEntityPersistenceMeta(ctor);
  return Object.values(meta.columns).some((c) => c.isClone === true);
}

export function getTableName(ctor: EntityClass): string {
  if (!isEntityClass(ctor)) {
    throw new TypeError("Expected a class decorated with @Entity(…) or @Entity()");
  }
  return META.get(ctor as Function)!.tableName!;
}

/**
 * Returns a schema-qualified table reference for SQL generation.
 * When the entity has an explicit @Entity("table", "schema") override,
 * returns `"schema"."table"`. Otherwise returns just `"table"` (relies on search_path).
 */
export function getQualifiedTableName(ctor: EntityClass): string {
  if (!isEntityClass(ctor)) {
    throw new TypeError("Expected a class decorated with @Entity(…) or @Entity()");
  }
  const m = META.get(ctor as Function)!;
  const table = m.tableName!;
  // Schema-domain enforcement: when a domain is configured the effective
  // schema is validated against the declared set and the ref is always
  // emitted qualified — no reliance on search_path ordering.
  if (getSchemaDomain()) {
    return `"${resolveEntitySchema(m)}"."${table}"`;
  }
  if (m.tableSchema) {
    return `"${m.tableSchema}"."${table}"`;
  }
  return `"${table}"`;
}

/** Logical entity name: the class name (e.g. `CustomerEntity`). */
export function getEntityName(ctor: EntityClass): string {
  if (!isEntityClass(ctor)) {
    throw new TypeError("Expected a class decorated with @Entity(…) or @Entity()");
  }
  return (ctor as Function).name;
}

export function getColumnName(ctor: EntityClass, propertyKey: string | symbol): string {
  if (!isEntityClass(ctor)) {
    throw new TypeError("Expected a class decorated with @Entity(…) or @Entity()");
  }
  syncImplicitEntityColumns(ctor as Function);
  const reg = collectEntityColumnRegistrations(ctor as Function).get(propertyKey);
  return reg?.sqlName ?? String(propertyKey);
}

/** `@Calculated` registration for `propertyKey`, or undefined when the prop
 *  is a physical/non-existent column. Used by the query builder to swap the
 *  column ref for the raw expression in WHERE/ORDER BY. */
export function getCalculatedColumn(
  ctor: EntityClass,
  propertyKey: string | symbol,
): CalculatedRegistration | undefined {
  if (!isEntityClass(ctor)) return undefined;
  syncImplicitEntityColumns(ctor as Function);
  return collectCalculatedRegistrations(ctor as Function).get(propertyKey);
}

export function getPrimaryKeyColumn(ctor: EntityClass): string {
  if (!isEntityClass(ctor)) {
    throw new TypeError("Expected a class decorated with @Entity(…) or @Entity()");
  }
  syncImplicitEntityColumns(ctor as Function);
  const keyCols: string[] = [];
  for (const [, v] of collectEntityColumnRegistrations(ctor as Function)) {
    if (v.isKey) keyCols.push(v.sqlName);
  }
  if (keyCols.length === 0) {
    throw new TypeError("Entity is missing @Key() on exactly one property");
  }
  if (keyCols.length > 1) {
    throw new TypeError("Entity has multiple @Key() columns; only one is supported");
  }
  return keyCols[0]!;
}

/** Property keys that map to SQL columns (implicit + decorated). */
export function listEntityPersistencePropertyKeys(ctor: EntityClass): string[] {
  if (!isEntityClass(ctor)) {
    throw new TypeError("Expected a class decorated with @Entity(…) or @Entity()");
  }
  syncImplicitEntityColumns(ctor as Function);
  return [...collectEntityColumnRegistrations(ctor as Function).keys()].map((k) => String(k));
}

/** Serializable persistence metadata (for JSON compare with DB introspection). */
export type EntityPersistenceMeta = {
  entityClassName: string;
  tableSchema: string;
  tableName: string;
  /** `@AuditTrail()` — entity has audit trail table */
  isAuditable?: boolean;
  /** `@AuditTrailEntity()` — entity IS an audit trail table (read-only audit log) */
  isAuditTrailEntity?: boolean;
  /** Column name used for the `changed_by` field in audit trail entities */
  auditTrailChangedByColumn?: string;
  columns: Record<
    string,
    {
      propertyKey: string;
      sqlName: string;
      isKey: boolean;
      isUnique: boolean;
      /** Composite unique index name (if part of a composite unique). */
      uniqueIndexName?: string;
      /** Order priority within a composite unique index (0-based). */
      uniqueIndexOrder?: number;
      /** Composite unique treats NULLs as equal (PG15+ `NULLS NOT DISTINCT`). */
      uniqueNullsNotDistinct?: boolean;
      nullable?: boolean;
      pgType?: string;
      jsType?: JsType;
      defaultSql?: string;
      length?: number;
      precision?: number;
      scale?: number;
      inferredPgType: string;
      usePostgresIdentity: boolean;
      isAuditable?: boolean;
      auditableType?: AuditableFieldType;
      isDeletable?: boolean;
      deletableType?: DeletableFieldType;
      isSynchronizable?: boolean;
      synchronizableType?: SynchronizableFieldType;
      isClone?: boolean;
      cloneType?: CloneFieldType;
      /** `@Ref("entity")` — served-meta ref target (meta-only, no DDL FK). */
      refEntity?: string;
      castInJoin?: string;
      /** `@PartitionField()` — RANGE partition key marker + options. */
      isPartition?: boolean;
      partitionOpts?: PartitionFieldOptions;
    }
  >;
  /** `@Calculated` SQL projections — keyed by **result alias** (`sqlName`).
   *  Not physical columns: absent from DDL, present in read projections.
   *  `pgType`/`nullable` are the declared result-type contract (meta + hydration). */
  calculated: Record<
    string,
    { propertyKey: string; sqlName: string; expr: string; pgType?: string; nullable?: boolean }
  >;
  /** Resolved partition declaration — present when a `@PartitionField` exists. */
  partition?: {
    column: string;
    interval: string;
    retention?: string;
    keepTable: boolean;
    premake?: number;
  };
  /** Resolved child-of declaration — present when `@PartitionChildOf` exists. */
  partitionChildOf?: {
    parentTable: string;
    parentSchema: string;
    refColumn: string;
    parentRefColumn: string;
  };
  /** Resolved index declarations — from `@Index()` columns, grouped + ordered. */
  indexes?: {
    name: string;
    columns: string[];
    using: IndexMethod;
    opclass?: string;
    where?: string;
  }[];
  /** Resolved foreign keys — from `@ForeignKey()` columns. */
  foreignKeys?: {
    column: string;
    refSchema: string;
    refTable: string;
    refColumn: string;
    onDelete: ForeignKeyAction;
    onUpdate: ForeignKeyAction;
    name: string;
  }[];
};

/**
 * Snapshot fragment for one @Entity class. `schema` defaults to `public`.
 * Column map is keyed by **SQL column name** so it aligns with `information_schema.columns`.
 */
export function getEntityPersistenceMeta(ctor: EntityClass, tableSchema?: string): EntityPersistenceMeta {
  if (!isEntityClass(ctor)) {
    throw new TypeError("Expected a class decorated with @Entity(…) or @Entity()");
  }
  const fn = ctor as Function;
  syncImplicitEntityColumns(fn);
  const classMeta = META.get(fn)!;
  // Entity-level schema override takes precedence; then the declared schema
  // domain primary; then the caller default (legacy `public`). Throws
  // SchemaDomainViolationError when the result is outside the domain.
  const effectiveSchema = resolveEntitySchema(classMeta, tableSchema ?? "public");
  const tableName = classMeta.tableName!;
  const entityClassName = fn.name;
  const columns: EntityPersistenceMeta["columns"] = {};
  // Merge column registrations + class-level flags across the prototype
  // chain — decorators register on the declaring class (e.g. a shared entity
  // base) while @Entity(schema) lives on the concrete subclass.
  const chain = collectMetaChain(fn);
  const colMap = collectEntityColumnRegistrations(fn);
  const inherited = <T>(pick: (m: ClassEntityMeta) => T | undefined): T | undefined => {
    for (let i = chain.length - 1; i >= 0; i--) {
      const v = pick(chain[i]);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  for (const [propKey, reg] of colMap) {
    const propertyKey = String(propKey);
    // Semantic defaults — decorator/type driven, never name driven:
    //   @AuditableField(CREATED_AT|UPDATED_AT) → now()
    //   @AuditableField(VERSION)               → 1
    //   resolved type `uuid` on a key/unique col → gen_random_uuid() (below,
    //   after type resolution — it needs the effective pgType).
    if (reg.defaultSql === undefined) {
      if (
        reg.auditableType === AuditableFieldType.CREATED_AT ||
        reg.auditableType === AuditableFieldType.UPDATED_AT
      ) {
        reg.defaultSql = "now()";
      } else if (reg.auditableType === AuditableFieldType.VERSION) {
        reg.defaultSql = "1";
      }
    }
    const inferredPgType = inferPgTypeFromEntityColumn({
      sqlName: reg.sqlName,
      propertyKey,
      isKey: reg.isKey,
      explicitPgType: reg.pgType,
      length: reg.length,
      precision: reg.precision,
      scale: reg.scale,
      auditableType: reg.auditableType,
      deletableType: reg.deletableType,
      synchronizableType: reg.synchronizableType,
      keyGenerated: reg.keyGenerated,
      jsType: reg.jsType,
    });
    if (
      reg.defaultSql === undefined &&
      inferredPgType === "uuid" &&
      (reg.isKey || reg.isUnique)
    ) {
      // uuid key/unique columns always default to uuidv7() — the
      // canonical generated identity (PG18 native, time-ordered).
      // `default: ColumnDefault.UUID_V4_DEFAULT_GENERATED` remains
      // available for columns that explicitly need v4.
      reg.defaultSql = ColumnDefault.UUID_V7_DEFAULT_GENERATED;
    }
    // GENERATED … AS IDENTITY is integer-family only — a uuid @Key
    // (the uuid-PK end state) carries its default via `defaultSql`
    // (uuidv7()), never via an identity clause.
    const usePostgresIdentity = Boolean(
      reg.isKey &&
        (reg.keyGenerated ?? "identity") === "identity" &&
        ["int2", "int4", "int8"].includes(inferredPgType),
    );
    const entry: EntityPersistenceMeta["columns"][string] = {
      propertyKey,
      sqlName: reg.sqlName,
      isKey: reg.isKey,
      isUnique: reg.isUnique,
      inferredPgType,
      usePostgresIdentity,
    };
    if (reg.uniqueIndexName !== undefined) entry.uniqueIndexName = reg.uniqueIndexName;
    if (reg.uniqueIndexOrder !== undefined) entry.uniqueIndexOrder = reg.uniqueIndexOrder;
    if (reg.uniqueNullsNotDistinct !== undefined) entry.uniqueNullsNotDistinct = reg.uniqueNullsNotDistinct;
    if (reg.pgType !== undefined) entry.pgType = reg.pgType;
    // NOT NULL by default: `design:type` inference was removed because it is
    // transpiler-dependent (esbuild/tsx never emits it; bun collapses unions).
    // Nullable columns must declare @Column({ nullable: true }) or use a
    // decorator that implies it (@DeletableField / @CloneField). Keys and
    // uniques already set nullable=false in their decorators.
    entry.nullable = reg.nullable ?? false;
    if (reg.defaultSql !== undefined) entry.defaultSql = reg.defaultSql;
    if (reg.length !== undefined) entry.length = reg.length;
    if (reg.precision !== undefined) entry.precision = reg.precision;
    if (reg.scale !== undefined) entry.scale = reg.scale;
    if (reg.jsType !== undefined) entry.jsType = reg.jsType;
    if (reg.isAuditable !== undefined) entry.isAuditable = reg.isAuditable;
    if (reg.auditableType !== undefined) entry.auditableType = reg.auditableType;
    if (reg.isDeletable !== undefined) entry.isDeletable = reg.isDeletable;
    if (reg.deletableType !== undefined) entry.deletableType = reg.deletableType;
    if (reg.isSynchronizable !== undefined) entry.isSynchronizable = reg.isSynchronizable;
    if (reg.synchronizableType !== undefined) entry.synchronizableType = reg.synchronizableType;
    if (reg.isClone !== undefined) entry.isClone = reg.isClone;
    if (reg.cloneType !== undefined) entry.cloneType = reg.cloneType;
    if (reg.refEntity !== undefined) entry.refEntity = reg.refEntity;
    if (reg.castInJoin !== undefined) entry.castInJoin = reg.castInJoin;
    if (reg.isPartition !== undefined) entry.isPartition = reg.isPartition;
    if (reg.partitionOpts !== undefined) entry.partitionOpts = reg.partitionOpts;
    columns[reg.sqlName] = entry;
  }

  // ── @Calculated resolution — projections, never physical columns ──────
  const calculated: EntityPersistenceMeta["calculated"] = {};
  for (const [propKey, reg] of collectCalculatedRegistrations(fn)) {
    const propertyKey = String(propKey);
    if (colMap.has(propKey)) {
      throw new TypeError(
        `${entityClassName}.${propertyKey}: @Calculated property is also registered as a physical column — remove the conflicting @Column/@Key/@Unique (or @IsNotColumn-style) registration`,
      );
    }
    calculated[reg.sqlName] = {
      propertyKey,
      sqlName: reg.sqlName,
      expr: reg.expr,
      pgType: reg.pgType,
      nullable: reg.nullable,
    };
  }

  // ── @PartitionField resolution + non-eludible validation ──────────────
  const partitionCols = Object.values(columns).filter((c) => c.isPartition);
  let partition: EntityPersistenceMeta["partition"];
  if (partitionCols.length > 1) {
    throw new TypeError(
      `${entityClassName}: multiple @PartitionField columns (${partitionCols.map((c) => c.sqlName).join(", ")}) — exactly one is allowed`,
    );
  }
  if (partitionCols.length === 1) {
    const pc = partitionCols[0]!;
    if (pc.nullable !== false) {
      throw new TypeError(
        `${entityClassName}.${pc.propertyKey}: @PartitionField column must be NOT NULL (RANGE partition keys cannot be null)`,
      );
    }
    // Type check on the explicit pgType only: the annotation-resolved type
    // is not knowable at runtime (static extractor is pipeline-only), so a
    // bare `Date` prop stays a valid partition key here — the schema
    // pipeline re-validates with the resolved type (buildEntitySnapshot).
    const t = (pc.pgType ?? "").toLowerCase();
    if (t !== "" && !/^(date|timestamp|timestamptz)/.test(t)) {
      throw new TypeError(
        `${entityClassName}.${pc.propertyKey}: @PartitionField column must be date/timestamp/timestamptz (RANGE-time axis), got "${pc.pgType}"`,
      );
    }
    // PostgreSQL: every unique constraint on a partitioned table must
    // contain the partition key. Single-column uniques are a group of one.
    const groups = new Map<string, Set<string>>();
    for (const c of Object.values(columns)) {
      if (!c.isUnique) continue;
      const g = c.uniqueIndexName ?? `__single__:${c.sqlName}`;
      (groups.get(g) ?? groups.set(g, new Set()).get(g)!).add(c.sqlName);
    }
    for (const [group, cols] of groups) {
      if (!cols.has(pc.sqlName)) {
        throw new TypeError(
          `${entityClassName}: unique constraint "${group}" (${[...cols].join(", ")}) does not include the partition key "${pc.sqlName}" — PostgreSQL rejects partitioned tables whose unique constraints lack the partition column. Add @PartitionField's column to the @Unique group (e.g. @Unique("${group === `__single__:${pc.sqlName}` ? `${tableName}_uq` : group}", 1)).`,
        );
      }
    }
    partition = {
      column: pc.sqlName,
      interval: pc.partitionOpts?.interval ?? "1 month",
      retention: pc.partitionOpts?.retention,
      keepTable: pc.partitionOpts?.keepTable ?? false,
      premake: pc.partitionOpts?.premake,
    };
  }

  // ── @PartitionChildOf resolution ──────────────────────────────────────
  let partitionChildOf: EntityPersistenceMeta["partitionChildOf"];
  const childOf = inherited((m) => m.partitionChildOf);
  if (childOf) {
    const refReg = colMap.get(childOf.ref);
    if (!refReg) {
      throw new TypeError(
        `${entityClassName}: @PartitionChildOf ref "${childOf.ref}" is not a column of this entity`,
      );
    }
    const parentFn = childOf.parent as Function;
    if (!isEntityClass(parentFn)) {
      throw new TypeError(
        `${entityClassName}: @PartitionChildOf parent must be an @Entity class`,
      );
    }
    syncImplicitEntityColumns(parentFn);
    const parentCols = collectEntityColumnRegistrations(parentFn);
    const parentRefKey = childOf.parentRef ?? "uuid";
    const parentRefReg = parentCols.get(parentRefKey);
    if (!parentRefReg) {
      throw new TypeError(
        `${entityClassName}: @PartitionChildOf parentRef "${parentRefKey}" is not a column of the parent entity`,
      );
    }
    partitionChildOf = {
      parentTable: getTableName(childOf.parent),
      parentSchema: META.get(parentFn)?.tableSchema ?? effectiveSchema,
      refColumn: refReg.sqlName,
      parentRefColumn: parentRefReg.sqlName,
    };
  }

  // ── @Index resolution: group by name (auto: <table>_<col>_idx), order by `order` ──
  const indexGroups = new Map<
    string,
    { cols: { sqlName: string; order: number }[]; using: IndexMethod; opclass?: string; where?: string }
  >();
  for (const reg of colMap.values()) {
    if (!reg.indexOpts) continue;
    const o = reg.indexOpts;
    const name = o.name ?? `${tableName}_${reg.sqlName}_idx`;
    const g = indexGroups.get(name) ?? { cols: [], using: o.using ?? "btree", opclass: o.opclass, where: o.where };
    if (
      (o.using !== undefined && o.using !== g.using) ||
      (o.where !== undefined && o.where !== g.where) ||
      (o.opclass !== undefined && o.opclass !== g.opclass)
    ) {
      throw new TypeError(
        `${entityClassName}.${reg.sqlName}: @Index group "${name}" has inconsistent using/opclass/where across its columns — declare them identically on every member`,
      );
    }
    if (o.using !== undefined) g.using = o.using;
    if (o.opclass !== undefined) g.opclass = o.opclass;
    if (o.where !== undefined) g.where = o.where;
    g.cols.push({ sqlName: reg.sqlName, order: o.order ?? 0 });
    indexGroups.set(name, g);
  }
  const indexes = indexGroups.size
    ? [...indexGroups.entries()].map(([name, g]) => ({
        name,
        columns: g.cols.sort((a, b) => a.order - b.order || a.sqlName.localeCompare(b.sqlName)).map((c) => c.sqlName),
        using: g.using,
        ...(g.opclass !== undefined ? { opclass: g.opclass } : {}),
        ...(g.where !== undefined ? { where: g.where } : {}),
      }))
    : undefined;

  // ── @ForeignKey resolution ────────────────────────────────────────────
  const foreignKeys: NonNullable<EntityPersistenceMeta["foreignKeys"]> = [];
  for (const [propKey, reg] of colMap) {
    if (!reg.foreignKey) continue;
    const target = reg.foreignKey.target() as Function;
    if (!isEntityClass(target)) {
      throw new TypeError(
        `${entityClassName}.${String(propKey)}: @ForeignKey target must be an @Entity class (use a lazy thunk: () => TargetEntity)`,
      );
    }
    const targetMeta = getEntityPersistenceMeta(target as EntityClass, effectiveSchema);
    if (targetMeta.partition) {
      throw new TypeError(
        `${entityClassName}.${String(propKey)}: @ForeignKey target "${targetMeta.tableSchema}.${targetMeta.tableName}" is a partitioned table — PostgreSQL requires every referenced unique constraint to include the partition key. Use @PartitionChildOf for partition-scoped children instead.`,
      );
    }
    const o = reg.foreignKey.opts;
    const refReg = [...collectEntityColumnRegistrations(target).entries()].find(
      ([, r]) => (o.column !== undefined ? r.sqlName === o.column : r.isKey),
    );
    if (!refReg) {
      throw new TypeError(
        `${entityClassName}.${String(propKey)}: @ForeignKey — target has no column ${o.column ? `"${o.column}"` : "marked @Key()"} to reference`,
      );
    }
    foreignKeys.push({
      column: reg.sqlName,
      refSchema: targetMeta.tableSchema,
      refTable: targetMeta.tableName,
      refColumn: refReg[1].sqlName,
      onDelete: o.onDelete ?? "restrict",
      onUpdate: o.onUpdate ?? "no_action",
      name: o.name ?? `${tableName}_${reg.sqlName}_fkey`,
    });
  }

  return {
    entityClassName,
    tableSchema: effectiveSchema,
    tableName,
    isAuditable: inherited((m) => m.isAuditable),
    isAuditTrailEntity: inherited((m) => m.isAuditTrailEntity),
    auditTrailChangedByColumn: inherited((m) => m.auditTrailChangedByColumn),
    partition,
    partitionChildOf,
    indexes,
    foreignKeys: foreignKeys.length ? foreignKeys : undefined,
    columns,
    calculated,
  };
}
