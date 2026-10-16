import { getEntityPersistenceMeta, type EntityClass, type EntityPersistenceMeta } from "../meta/entity-meta.js";
import { type SchemaColumnMeta, type SchemaIndexMeta, type SchemaSnapshot, tableKey } from "./schema-types.js";
import { lookupEntityAnnotation, type EntityAnnotationMap } from "../meta/entity-annotation-extract.js";
import {
  columnTypeWarnings,
  resolvePgTypeForSchema,
  type EntityColumnTypeHints,
  type EntityTypeWarning,
} from "../meta/entity-ts-to-pg.js";

export type BuildEntitySnapshotOptions = {
  /**
   * Static annotation map from `extractEntityAnnotations` — the
   * authoritative type source. When provided, every column type resolves
   * deterministically (explicit pgType → semantic pin → TS annotation) and
   * unmappable properties THROW. When omitted (pure-runtime path, e.g.
   * internal tests), resolution falls back to `pgType ?? inferredPgType`.
   */
  annotations?: EntityAnnotationMap;
};

/** `@Unique()` columns grouped into index metas (single-col uniques = group of one). */
function uniqueGroups(meta: EntityPersistenceMeta): SchemaIndexMeta[] {
  const groups = new Map<string, { col: string; order: number }[]>();
  for (const c of Object.values(meta.columns)) {
    if (!c.isUnique) continue;
    const name = c.uniqueIndexName ?? `${meta.tableName}_${c.sqlName}_uq`;
    const g = groups.get(name) ?? [];
    g.push({ col: c.sqlName, order: c.uniqueIndexOrder ?? 0 });
    groups.set(name, g);
  }
  return [...groups.entries()].map(([name, cols]) => ({
    name,
    columns: cols.sort((a, b) => a.order - b.order).map((c) => c.col),
    using: "btree",
    isUnique: true,
  }));
}

/**
 * Advisory authoring warnings across a registry — `*_uuid` columns that do
 * not resolve to `uuid`, and `pgType` declarations that restate the inferred
 * default. Requires the static annotation map; warnings never fail a gate.
 */
export function collectEntityTypeWarnings(
  registry: readonly EntityClass[],
  annotations: EntityAnnotationMap,
): EntityTypeWarning[] {
  const out: EntityTypeWarning[] = [];
  for (const ctor of registry) {
    const meta = getEntityPersistenceMeta(ctor);
    for (const [sqlName, c] of Object.entries(meta.columns)) {
      const hints: EntityColumnTypeHints = {
        sqlName,
        propertyKey: c.propertyKey,
        isKey: c.isKey,
        explicitPgType: c.pgType,
        length: c.length,
        precision: c.precision,
        scale: c.scale,
        auditableType: c.auditableType,
        deletableType: c.deletableType,
        synchronizableType: c.synchronizableType,
        annotation: lookupEntityAnnotation(annotations, meta.entityClassName, c.propertyKey),
      };
      out.push(...columnTypeWarnings(meta.entityClassName, hints, resolvePgTypeForSchema(hints)));
    }
  }
  return out;
}

/**
 * Canonical entity-intent snapshot for a service's entity registry.
 * Parameterized on the registry — no service-specific imports live here.
 */
export function buildEntitySnapshot(
  registry: readonly EntityClass[],
  opts?: BuildEntitySnapshotOptions,
  generatedAt = new Date().toISOString()
): SchemaSnapshot {
  const tables: SchemaSnapshot["tables"] = {};
  for (const ctor of registry) {
    const meta = getEntityPersistenceMeta(ctor);
    const key = tableKey(meta.tableSchema, meta.tableName);
    const annots = opts?.annotations;
    const columns: Record<string, SchemaColumnMeta> = {};
    let ord = 1;
    for (const [sqlName, c] of Object.entries(meta.columns)) {
      const hint = opts?.annotations
        ? resolvePgTypeForSchema({
            sqlName,
            propertyKey: c.propertyKey,
            isKey: c.isKey,
            explicitPgType: c.pgType,
            length: c.length,
            precision: c.precision,
            scale: c.scale,
            auditableType: c.auditableType,
            deletableType: c.deletableType,
            synchronizableType: c.synchronizableType,
            annotation: lookupEntityAnnotation(annots!, meta.entityClassName, c.propertyKey),
          })
        : (c.pgType ?? c.inferredPgType);
      const col: SchemaColumnMeta = {
        name: sqlName,
        ordinalPosition: ord++,
        dataType: hint,
        typname: hint,
        isPrimaryKey: c.isKey,
        isUnique: c.isUnique,
        isPostgresIdentity: c.usePostgresIdentity,
        propertyKey: c.propertyKey,
      };
      col.isNullable = c.nullable;
      if (c.defaultSql !== undefined) col.defaultSql = c.defaultSql;
      columns[sqlName] = col;
    }
    tables[key] = {
      kind: "table",
      schema: meta.tableSchema,
      name: meta.tableName,
      entityClassName: meta.entityClassName,
      isAuditable: meta.isAuditable,
      columns,
      ...(meta.partition ? { partition: meta.partition } : {}),
      ...(meta.partitionChildOf ? { partitionChildOf: meta.partitionChildOf } : {}),
      ...(meta.indexes || uniqueGroups(meta).length
        ? {
            indexes: [
              ...(meta.indexes ?? []),
              ...uniqueGroups(meta), // @Unique groups surface as unique indexes
            ],
          }
        : {}),
      ...(meta.foreignKeys
        ? {
            foreignKeys: meta.foreignKeys.map((f) => ({
              name: f.name,
              column: f.column,
              refSchema: f.refSchema,
              refTable: f.refTable,
              refColumn: f.refColumn,
              onDelete: f.onDelete,
              onUpdate: f.onUpdate,
            })),
          }
        : {}),
    };
  }
  return { version: 1, generatedAt, source: "entities", tables };
}
