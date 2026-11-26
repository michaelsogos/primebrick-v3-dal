import { DeletableFieldType, getEntityPersistenceMeta, type EntityClass, type EntityPersistenceMeta } from "../meta/entity-meta.js";
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

/**
 * `@Unique`/`@UniqueIndex` declarations grouped into index metas.
 *
 * - bare `@Unique()` → auto-named single-column group `<table>_<col>_uq`;
 * - `@Unique(name, order)` → membership in the class-level `@UniqueIndex({name})`
 *   decl (validated at meta resolution — a decl always exists here).
 *
 * `aliveOnly` resolution: `spec.aliveOnly ?? entity-is-Deletable` — the
 * default is ON for Deletable tables (a full unique would let a tombstone
 * block re-creation of the value forever). The emitted predicate order is
 * `(<where>) AND (deleted_at IS NULL)` so it normalizes identically to the
 * live `pg_get_indexdef` rendering.
 */
function uniqueGroups(meta: EntityPersistenceMeta): SchemaIndexMeta[] {
  const deletable = Object.values(meta.columns).some(
    (c) => c.deletableType === DeletableFieldType.DELETED_AT,
  );
  const decls = new Map((meta.uniqueIndexes ?? []).map((s) => [s.name, s]));
  const groups = new Map<
    string,
    { cols: { col: string; order: number }[]; spec?: NonNullable<typeof meta.uniqueIndexes>[number] }
  >();
  for (const c of Object.values(meta.columns)) {
    if (!c.isUnique) continue;
    if (c.uniques?.length) {
      for (const u of c.uniques) {
        const g = groups.get(u.name) ?? { cols: [], spec: decls.get(u.name) };
        g.cols.push({ col: c.sqlName, order: u.order });
        groups.set(u.name, g);
      }
    } else {
      // bare @Unique() — auto-named single-column group
      groups.set(`${meta.tableName}_${c.sqlName}_uq`, { cols: [{ col: c.sqlName, order: 0 }] });
    }
  }
  return [...groups.entries()].map(([name, g]) => {
    const spec = g.spec;
    const aliveOnly = spec?.aliveOnly ?? deletable;
    const where = spec?.where
      ? aliveOnly
        ? `(${spec.where}) AND (deleted_at IS NULL)`
        : spec.where
      : aliveOnly
        ? "deleted_at IS NULL"
        : undefined;
    return {
      name,
      columns: g.cols.sort((a, b) => a.order - b.order).map((c) => c.col),
      using: "btree",
      isUnique: true,
      ...(spec?.nullsNotDistinct ? { nullsNotDistinct: true } : {}),
      ...(where ? { where } : {}),
    };
  });
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
        jsType: c.jsType,
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
            jsType: c.jsType,
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
      ...(meta.retention ? { retention: meta.retention } : {}),
      ...(meta.auditRetention ? { auditRetention: meta.auditRetention } : {}),
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
