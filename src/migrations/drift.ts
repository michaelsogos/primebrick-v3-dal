/**
 * Drift check — entity intent vs live catalog, post-apply and standalone.
 * Powers the post-migration verification, `primebrick-db check`, and the
 * service status badge surfaced in the admin migrations page.
 */

import { getEntityPersistenceMeta, type EntityClass } from "../meta/entity-meta.js";
import { buildDatabaseSnapshot, type SnapshotQueryable } from "../schema-diff/build-database-snapshot.js";
import { buildEntitySnapshot, type BuildEntitySnapshotOptions } from "../schema-diff/build-entity-snapshot.js";
import { compareSnapshots, type SchemaMetaDiffV2 } from "../schema-diff/schema-snapshot.js";

export async function checkDrift(
  registry: readonly EntityClass[],
  db: SnapshotQueryable,
  opts?: BuildEntitySnapshotOptions
): Promise<SchemaMetaDiffV2> {
  const entitySnap = buildEntitySnapshot(registry, opts);
  const tables = registry.map((c) => {
    const m = getEntityPersistenceMeta(c);
    return { schema: m.tableSchema, name: m.tableName };
  });
  const dbSnap = await buildDatabaseSnapshot(db, tables);
  return compareSnapshots(entitySnap, dbSnap);
}

/**
 * True when the diff contains only database-only objects (extras we never
 * drop) — i.e. no unapplied entity intent remains.
 */
export function isDriftClean(diff: SchemaMetaDiffV2): boolean {
  if (diff.onlyInEntityTables.length > 0) return false;
  for (const t of Object.values(diff.tables)) {
    if (
      t.onlyInEntityColumns.length ||
      t.likelyRenames.length ||
      t.typeMismatches.length ||
      t.nullabilityMismatches.length ||
      (t.onlyInEntityIndexes?.length ?? 0) > 0 ||
      (t.indexMismatches?.length ?? 0) > 0 ||
      (t.onlyInEntityForeignKeys?.length ?? 0) > 0 ||
      (t.foreignKeyMismatches?.length ?? 0) > 0
    ) {
      return false;
    }
  }
  return true;
}
