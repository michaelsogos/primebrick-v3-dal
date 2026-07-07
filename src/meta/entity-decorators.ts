import "reflect-metadata";

import {
  inferColumnNullableFromDesignType,
  inferPgTypeFromEntityColumn,
} from "./entity-ts-to-pg.js";

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

type ColumnRegistration = {
  sqlName: string;
  isKey: boolean;
  isUnique: boolean;
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
  tsDesignTypeCtorName?: string;
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
  /** Cast type to apply when this field is used in JOIN ON clause */
  castInJoin?: string;
};

export type ColumnOptions = {
  sqlName?: string;
  /**
   * PostgreSQL storage type for DDL + DAL (`column-pg-io`).
   * TS `Date` without `pgType` → **`timestamptz`** in migration;
   * `pgType: 'date'` → SQL `date` + bind `YYYY-MM-DD`.
   */
  pgType?: string;
  /** e.g. varchar(20) */
  length?: number;
  /** e.g. numeric(18,2) */
  precision?: number;
  scale?: number;
  nullable?: boolean;
  /** SQL DEFAULT expression (raw). */
  defaultSql?: string;
  /** Cast type to apply when this field is used in JOIN ON clause (e.g., 'uuid') */
  castInJoin?: string;
};

type ClassEntityMeta = {
  tableName?: string;
  /** Optional schema override — if set, takes precedence over the Dal's default schema. */
  tableSchema?: string;
  columns: Map<PropertyKey, ColumnRegistration>;
  /** `@IsNotColumn()` — excluded from persistence meta & future DAL builders */
  notColumnKeys: Set<PropertyKey>;
  /** `@AuditTrail()` — entity has audit trail table */
  isAuditable?: boolean;
};

const META = new WeakMap<Function, ClassEntityMeta>();

function ensureMeta(ctor: Function): ClassEntityMeta {
  let m = META.get(ctor);
  if (!m) {
    m = { columns: new Map(), notColumnKeys: new Set() };
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
    const col = touchColumn(ctor, key);
    const dt = Reflect.getMetadata("design:type", ctor.prototype, metaKey);
    if (col.tsDesignTypeCtorName === undefined && dt && typeof (dt as { name?: string }).name === "string") {
      col.tsDesignTypeCtorName = (dt as Function).name;
    }
    if (col.nullable === undefined) {
      const inf = inferColumnNullableFromDesignType(dt, col.isKey, col.isUnique);
      if (inf !== undefined) col.nullable = inf;
    }
  }
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
    o.castInJoin === undefined
  ) {
    throw new TypeError(
      "@Column({ … }) requires at least one of: sqlName, pgType, length, precision/scale, nullable, defaultSql, castInJoin"
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
    const dt = Reflect.getMetadata("design:type", target, propertyKey);
    if (dt && typeof (dt as { name?: string }).name === "string") {
      col.tsDesignTypeCtorName = (dt as Function).name;
    }
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
      if (sqlNameOrOpts.defaultSql !== undefined) col.defaultSql = sqlNameOrOpts.defaultSql;
      if (sqlNameOrOpts.castInJoin !== undefined) col.castInJoin = sqlNameOrOpts.castInJoin;
    }
    if (col.nullable === undefined) {
      const inferred = inferColumnNullableFromDesignType(dt, col.isKey, col.isUnique);
      if (inferred !== undefined) col.nullable = inferred;
    }
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

/** Unique constraint (PostgreSQL: unique index in generated patches). */
export function Unique(): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol) {
    const ctor = (target as { constructor: Function }).constructor;
    const col = touchColumn(ctor, propertyKey);
    col.isUnique = true;
    col.nullable = false;
    const dt = Reflect.getMetadata("design:type", target, propertyKey);
    if (dt && typeof (dt as { name?: string }).name === "string") {
      col.tsDesignTypeCtorName = (dt as Function).name;
    }
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
    const dt = Reflect.getMetadata("design:type", target, propertyKey);
    if (dt && typeof (dt as { name?: string }).name === "string") {
      col.tsDesignTypeCtorName = (dt as Function).name;
    }
  };
}

/** Marks a field as auditable (created_at, created_by, updated_at, updated_by, version). */
export function AuditableField(what: AuditableFieldType): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol) {
    const ctor = (target as { constructor: Function }).constructor;
    const col = touchColumn(ctor, propertyKey);
    col.isAuditable = true;
    col.auditableType = what;
    const dt = Reflect.getMetadata("design:type", target, propertyKey);
    if (dt && typeof (dt as { name?: string }).name === "string") {
      col.tsDesignTypeCtorName = (dt as Function).name;
    }
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
    const dt = Reflect.getMetadata("design:type", target, propertyKey);
    if (dt && typeof (dt as { name?: string }).name === "string") {
      col.tsDesignTypeCtorName = (dt as Function).name;
    }
  };
}

/** Marks a field as synchronizable (last_synced_at). */
export function SynchronizableField(what: SynchronizableFieldType): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol) {
    const ctor = (target as { constructor: Function }).constructor;
    const col = touchColumn(ctor, propertyKey);
    col.isSynchronizable = true;
    col.synchronizableType = what;
    const dt = Reflect.getMetadata("design:type", target, propertyKey);
    if (dt && typeof (dt as { name?: string }).name === "string") {
      col.tsDesignTypeCtorName = (dt as Function).name;
    }
  };
}

/** Marks a field as clone tracking (cloned_from). Stores UUID of the source record. */
export function CloneField(): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol) {
    const ctor = (target as { constructor: Function }).constructor;
    const col = touchColumn(ctor, propertyKey);
    col.isClone = true;
    col.nullable = true;
    const dt = Reflect.getMetadata("design:type", target, propertyKey);
    if (dt && typeof (dt as { name?: string }).name === "string") {
      col.tsDesignTypeCtorName = (dt as Function).name;
    }
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

export function isEntityClass(value: unknown): value is EntityClass {
  return typeof value === "function" && META.get(value as Function)?.tableName !== undefined;
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
  const reg = META.get(ctor as Function)?.columns.get(propertyKey);
  return reg?.sqlName ?? String(propertyKey);
}

export function getPrimaryKeyColumn(ctor: EntityClass): string {
  if (!isEntityClass(ctor)) {
    throw new TypeError("Expected a class decorated with @Entity(…) or @Entity()");
  }
  syncImplicitEntityColumns(ctor as Function);
  const cols = META.get(ctor as Function)!.columns;
  const keyCols: string[] = [];
  for (const [, v] of cols) {
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
  const cols = META.get(ctor as Function)!.columns;
  return [...cols.keys()].map((k) => String(k));
}

/** Serializable persistence metadata (for JSON compare with DB introspection). */
export type EntityPersistenceMeta = {
  entityClassName: string;
  tableSchema: string;
  tableName: string;
  /** `@AuditTrail()` — entity has audit trail table */
  isAuditable?: boolean;
  columns: Record<
    string,
    {
      propertyKey: string;
      sqlName: string;
      isKey: boolean;
      isUnique: boolean;
      nullable?: boolean;
      pgType?: string;
      tsDesignTypeCtorName?: string;
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
      castInJoin?: string;
    }
  >;
};

/**
 * Snapshot fragment for one @Entity class. `schema` defaults to `public`.
 * Column map is keyed by **SQL column name** so it aligns with `information_schema.columns`.
 */
export function getEntityPersistenceMeta(ctor: EntityClass, tableSchema = "public"): EntityPersistenceMeta {
  if (!isEntityClass(ctor)) {
    throw new TypeError("Expected a class decorated with @Entity(…) or @Entity()");
  }
  const fn = ctor as Function;
  syncImplicitEntityColumns(fn);
  const classMeta = META.get(fn)!;
  // Entity-level schema override takes precedence over the caller-provided default
  const effectiveSchema = classMeta.tableSchema ?? tableSchema;
  const tableName = classMeta.tableName!;
  const entityClassName = fn.name;
  const columns: EntityPersistenceMeta["columns"] = {};
  const colMap = META.get(fn)!.columns;
  for (const [propKey, reg] of colMap) {
    const propertyKey = String(propKey);
    const sqlLower = reg.sqlName.toLowerCase();
    if (reg.defaultSql === undefined) {
      if (sqlLower === "uuid") {
        const provider = (process.env.PB_UUID_DEFAULT_PROVIDER ?? "pgcrypto").toLowerCase();
        reg.defaultSql = provider === "uuid-ossp" ? "uuid_generate_v4()" : "gen_random_uuid()";
      } else if (sqlLower === "created_at" || sqlLower === "updated_at") {
        reg.defaultSql = "now()";
      } else if (sqlLower === "version") {
        reg.defaultSql = "1";
      }
    }
    const inferredPgType = inferPgTypeFromEntityColumn({
      sqlName: reg.sqlName,
      propertyKey,
      isKey: reg.isKey,
      tsDesignTypeCtorName: reg.tsDesignTypeCtorName,
      explicitPgType: reg.pgType,
      length: reg.length,
      precision: reg.precision,
      scale: reg.scale,
    });
    const usePostgresIdentity = Boolean(reg.isKey && (reg.keyGenerated ?? "identity") === "identity");
    const entry: EntityPersistenceMeta["columns"][string] = {
      propertyKey,
      sqlName: reg.sqlName,
      isKey: reg.isKey,
      isUnique: reg.isUnique,
      inferredPgType,
      usePostgresIdentity,
    };
    if (reg.pgType !== undefined) entry.pgType = reg.pgType;
    entry.nullable = reg.nullable ?? (reg.isKey || reg.isUnique ? false : true);
    if (reg.defaultSql !== undefined) entry.defaultSql = reg.defaultSql;
    if (reg.length !== undefined) entry.length = reg.length;
    if (reg.precision !== undefined) entry.precision = reg.precision;
    if (reg.scale !== undefined) entry.scale = reg.scale;
    if (reg.tsDesignTypeCtorName !== undefined) entry.tsDesignTypeCtorName = reg.tsDesignTypeCtorName;
    if (reg.isAuditable !== undefined) entry.isAuditable = reg.isAuditable;
    if (reg.auditableType !== undefined) entry.auditableType = reg.auditableType;
    if (reg.isDeletable !== undefined) entry.isDeletable = reg.isDeletable;
    if (reg.deletableType !== undefined) entry.deletableType = reg.deletableType;
    if (reg.isSynchronizable !== undefined) entry.isSynchronizable = reg.isSynchronizable;
    if (reg.synchronizableType !== undefined) entry.synchronizableType = reg.synchronizableType;
    if (reg.isClone !== undefined) entry.isClone = reg.isClone;
    if (reg.castInJoin !== undefined) entry.castInJoin = reg.castInJoin;
    columns[reg.sqlName] = entry;
  }
  return {
    entityClassName,
    tableSchema: effectiveSchema,
    tableName,
    isAuditable: classMeta.isAuditable,
    columns,
  };
}
