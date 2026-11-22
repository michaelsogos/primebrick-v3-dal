/**
 * Shared shapes for entity vs database schema snapshots (used by compare + heuristics).
 */

export type SchemaColumnMeta = {
  /** SQL identifier */
  name: string;
  /** Ordinal in table (1-based), from pg_attribute.attnum or declaration order */
  ordinalPosition?: number | null;
  /** `information_schema`-style or entity hint */
  dataType?: string | null;
  /** Physical type name from pg_type.typname (PostGIS: geometry, geography, …) */
  typname?: string | null;
  /** `pg_type.oid` */
  typeOid?: number | null;
  typcategory?: string | null;
  /** `pg_catalog.format_type(atttypid, atttypmod)` */
  formatType?: string | null;
  numericPrecision?: number | null;
  numericScale?: number | null;
  isNullable?: boolean | null;
  /** From @Key() on entity side; from PK discovery on DB side when available */
  isPrimaryKey?: boolean;
  /** Entity: `@Unique()` → emit `CREATE UNIQUE INDEX` in DDL patches */
  isUnique?: boolean;
  /** Entity: surrogate `id` PK → `bigint generated … as identity` in DDL */
  isPostgresIdentity?: boolean;
  /** Entity: SQL DEFAULT expression (raw). */
  defaultSql?: string;
  /** Entity side: TS property backing this column */
  propertyKey?: string;
};

export type SchemaIndexMeta = {
  name: string;
  columns: string[];
  /** PG access method — btree|hash|gin|gist|spgist|brin|hnsw */
  using: string;
  opclass?: string;
  /** Partial-index predicate */
  where?: string;
  isUnique?: boolean;
  /** PG15+ `NULLS NOT DISTINCT` on unique indexes — NULL members conflict. */
  nullsNotDistinct?: boolean;
  /** Raw SQL expression keys — emitted verbatim (parenthesized) BEFORE the
   *  plain `columns`. Produced by the `@Relation` pair-unique derivation
   *  (`LEAST`/`GREATEST` unordered-pair keys); index comparison normalizes
   *  them against `pg_get_indexdef` output, never against column lists. */
  expressions?: string[];
  /** Full rendered index definition — captured from `pg_get_indexdef` on
   *  database introspection; used as the normalized-comparison fallback
   *  for expression indexes. */
  definition?: string;
};

export type SchemaForeignKeyMeta = {
  name: string;
  column: string;
  refSchema: string;
  refTable: string;
  refColumn: string;
  onDelete: string;
  onUpdate: string;
};

export type SchemaTableMeta = {
  kind: "table";
  schema: string;
  name: string;
  entityClassName?: string;
  /** Entity: @AuditTrail() decorator present */
  isAuditable?: boolean;
  /** Entity: resolved @Partition declaration (pg_partman RANGE parent) —
   *  slicing only; expiry lives on `retention`. */
  partition?: {
    column: string;
    interval: string;
    keepTable: boolean;
    premake?: number;
  };
  /** Entity: resolved @Retention declaration (expiry policy — partition
   *  drop on partitioned tables, row sweep on plain tables). */
  retention?: {
    column: string;
    duration: string;
  };
  /** `@AuditTrail({retention})` — audit-table retention override
   *  (default `"12 months"` applied at emission). */
  auditRetention?: string;
  /** Entity: resolved @PartitionChildOf declaration */
  partitionChildOf?: {
    parentTable: string;
    parentSchema: string;
    refColumn: string;
    parentRefColumn: string;
  };
  /** Entity @Index() declarations (and DB-side non-PK indexes on introspection) */
  indexes?: SchemaIndexMeta[];
  /** Entity @ForeignKey() declarations (and DB-side FK constraints on introspection) */
  foreignKeys?: SchemaForeignKeyMeta[];
  columns: Record<string, SchemaColumnMeta>;
};

export type SchemaSnapshot = {
  version: 1;
  generatedAt: string;
  source: "entities" | "database";
  /** `source:"database"` only: the introspection captured column DEFAULT
   *  expressions (`pg_attrdef`). Absent on snapshots written before the
   *  capture existed — the default diff treats them as "unknown", never
   *  as "no default" (stale snapshots can't false-flag every declared
   *  `defaultSql` as missing). */
  capturesDefaults?: boolean;
  tables: Record<string, SchemaTableMeta>;
};

export function tableKey(schema: string, name: string): string {
  return `${schema}.${name}`;
}
