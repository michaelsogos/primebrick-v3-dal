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
  /** Entity: resolved @PartitionField declaration (pg_partman RANGE parent) */
  partition?: {
    column: string;
    interval: string;
    retention?: string;
    keepTable: boolean;
    premake?: number;
  };
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
  tables: Record<string, SchemaTableMeta>;
};

export function tableKey(schema: string, name: string): string {
  return `${schema}.${name}`;
}
