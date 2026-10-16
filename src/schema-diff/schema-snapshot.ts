/**
 * Compare canonical JSON snapshots: “intent” (@Entity metadata) vs PostgreSQL catalog.
 * Uses pg_catalog-style typing (via snapshot) + rename heuristics inspired by pg-diff workflows.
 */

import {
  findLikelyRenames,
  RENAME_HEURISTIC_AGENT_INSTRUCTION,
  type LikelyRename,
  type RenameAmbiguity,
} from "./schema-rename-heuristics.js";
import type { SchemaIndexMeta, SchemaSnapshot } from "./schema-types.js";
import { comparablePgType } from "./schema-type-normalize.js";

export type { LikelyRename, RenameAmbiguity, RenameHeuristicResult } from "./schema-rename-heuristics.js";
export { RENAME_HEURISTIC_AGENT_INSTRUCTION } from "./schema-rename-heuristics.js";
export type { SchemaColumnMeta, SchemaSnapshot, SchemaTableMeta } from "./schema-types.js";
export { tableKey } from "./schema-types.js";

export type SchemaMetaDiffV2 = {
  version: 2;
  generatedAt: string;
  onlyInEntityTables: string[];
  onlyInDatabaseTables: string[];
  /**
   * True if any shared table had ambiguous rename candidates. Coding agents must ask the user
   * before applying `likelyRenames` SQL; `onlyIn*` column lists intentionally ignore heuristic
   * renames in that case so nothing looks “auto-resolved”.
   */
  renameHeuristicUserReviewRequired?: boolean;
  /** Present when {@link SchemaMetaDiffV2.renameHeuristicUserReviewRequired} is true. */
  renameHeuristicAgentInstruction?: string;
  tables: Record<
    string,
    {
      onlyInEntityColumns: string[];
      onlyInDatabaseColumns: string[];
      likelyRenames: LikelyRename[];
      renameHeuristicUserReviewRequired?: boolean;
      renameHeuristicAmbiguities?: RenameAmbiguity[];
      typeMismatches: {
        column: string;
        entityComparable: string;
        databaseComparable: string;
        entityType?: string | null;
        databaseType?: string | null;
        entityTypname?: string | null;
        databaseTypname?: string | null;
      }[];
      nullabilityMismatches: {
        column: string;
        entityNullable?: boolean | null;
        databaseNullable?: boolean | null;
      }[];
      /** Index names declared only on the entity side (@Index/@Unique groups) */
      onlyInEntityIndexes: string[];
      /** Non-PK index names present only in the database */
      onlyInDatabaseIndexes: string[];
      /** Same-name indexes whose definition diverges (using/columns/predicate) */
      indexMismatches: {
        name: string;
        entityUsing?: string | null;
        databaseUsing?: string | null;
        entityColumns: string[];
        databaseColumns: string[];
      }[];
      /** FK constraint names declared only on the entity side */
      onlyInEntityForeignKeys: string[];
      /** FK constraint names present only in the database */
      onlyInDatabaseForeignKeys: string[];
      foreignKeyMismatches: {
        name: string;
        entityRef?: string | null;
        databaseRef?: string | null;
        entityOnDelete?: string | null;
        databaseOnDelete?: string | null;
      }[];
    }
  >;
};

/** @deprecated Prefer {@link SchemaMetaDiffV2} */
export type SchemaMetaDiffV1 = SchemaMetaDiffV2;

export function compareSnapshots(entitySnap: SchemaSnapshot, dbSnap: SchemaSnapshot): SchemaMetaDiffV2 {
  const entityKeys = new Set(Object.keys(entitySnap.tables));
  const dbKeys = new Set(Object.keys(dbSnap.tables));
  const onlyInEntityTables = [...entityKeys].filter((k) => !dbKeys.has(k));
  const onlyInDatabaseTables = [...dbKeys].filter((k) => !entityKeys.has(k));
  const tables: SchemaMetaDiffV2["tables"] = {};
  let anyRenameHeuristicReview = false;

  for (const key of entityKeys) {
    if (!dbKeys.has(key)) continue;
    const et = entitySnap.tables[key]!;
    const dt = dbSnap.tables[key]!;
    const eCols = new Set(Object.keys(et.columns));
    const dCols = new Set(Object.keys(dt.columns));
    const rawOnlyInEntity = [...eCols].filter((c) => !dCols.has(c));
    const rawOnlyInDb = [...dCols].filter((c) => !eCols.has(c));

    const renameHeuristic = findLikelyRenames(
      et.schema,
      et.name,
      rawOnlyInEntity,
      rawOnlyInDb,
      et.columns,
      dt.columns
    );
    if (renameHeuristic.userReviewRequired) anyRenameHeuristicReview = true;

    const applyHeuristicRenamesToColumnLists = !renameHeuristic.userReviewRequired;
    const renamedFromDb = applyHeuristicRenamesToColumnLists
      ? new Set(renameHeuristic.likelyRenames.map((r) => r.databaseColumn))
      : new Set<string>();
    const renamedFromEntity = applyHeuristicRenamesToColumnLists
      ? new Set(renameHeuristic.likelyRenames.map((r) => r.entityColumn))
      : new Set<string>();
    const onlyInEntityColumns = rawOnlyInEntity.filter((c) => !renamedFromEntity.has(c));
    const onlyInDatabaseColumns = rawOnlyInDb.filter((c) => !renamedFromDb.has(c));

    const typeMismatches: SchemaMetaDiffV2["tables"][string]["typeMismatches"] = [];
    const nullabilityMismatches: SchemaMetaDiffV2["tables"][string]["nullabilityMismatches"] = [];

    for (const col of [...eCols].filter((c) => dCols.has(c))) {
      const ec = et.columns[col]!;
      const dc = dt.columns[col]!;
      const eComp = comparablePgType(ec);
      const dComp = comparablePgType(dc);
      // Skip when the entity declares no PG type hint (`unknown`); avoid noisy diffs vs catalog.
      if (eComp !== "unknown" && eComp !== dComp) {
        typeMismatches.push({
          column: col,
          entityComparable: eComp,
          databaseComparable: dComp,
          entityType: ec.dataType ?? null,
          databaseType: dc.dataType ?? dc.formatType ?? null,
          entityTypname: ec.typname ?? null,
          databaseTypname: dc.typname ?? null,
        });
      }
      if (ec.isNullable != null && dc.isNullable != null && ec.isNullable !== dc.isNullable) {
        nullabilityMismatches.push({ column: col, entityNullable: ec.isNullable, databaseNullable: dc.isNullable });
      }
    }

    // ── index diff (matched by index name — our names are deterministic) ──
    const eIdx = new Map((et.indexes ?? []).map((i) => [i.name, i]));
    const dIdx = new Map((dt.indexes ?? []).map((i) => [i.name, i]));
    // An entity index is satisfied by ANY DB index with identical columns,
    // uniqueness, access method and predicate — constraint equivalence is
    // what matters; a different catalog name must not trigger a duplicate
    // CREATE (INDEX|UNIQUE INDEX) CONCURRENTLY.
    const normWhere = (w?: string) =>
      (w ?? "").replace(/[\s()]+/g, "").toLowerCase();
    const equivIndex = (ei: SchemaIndexMeta, di: SchemaIndexMeta) =>
      !!ei.isUnique === !!di.isUnique &&
      (ei.using ?? "btree") === (di.using ?? "btree") &&
      ei.columns.length === di.columns.length &&
      ei.columns.every((c, i) => c === di.columns[i]) &&
      normWhere(ei.where) === normWhere(di.where);
    const dIdxList = [...dIdx.values()];
    const onlyInEntityIndexes = [...eIdx.entries()]
      .filter(([k, ei]) => !dIdx.has(k) && !dIdxList.some((di) => equivIndex(ei, di)))
      .map(([k]) => k);
    const onlyInDatabaseIndexes = [...dIdx.keys()].filter((k) => !eIdx.has(k));
    const indexMismatches: NonNullable<
      SchemaMetaDiffV2["tables"][string]["indexMismatches"]
    > = [];
    for (const [nm, ei] of eIdx) {
      const di = dIdx.get(nm);
      if (!di) continue;
      const sameCols =
        ei.columns.length === di.columns.length &&
        ei.columns.every((c, i) => c === di.columns[i]);
      if (ei.using !== di.using || !sameCols || (ei.where ?? "") !== (di.where ?? "")) {
        indexMismatches.push({
          name: nm,
          entityUsing: ei.using ?? null,
          databaseUsing: di.using ?? null,
          entityColumns: ei.columns,
          databaseColumns: di.columns,
        });
      }
    }

    // ── foreign key diff (matched by constraint name) ────────────────────
    const eFk = new Map((et.foreignKeys ?? []).map((f) => [f.name, f]));
    const dFk = new Map((dt.foreignKeys ?? []).map((f) => [f.name, f]));
    const onlyInEntityForeignKeys = [...eFk.keys()].filter((k) => !dFk.has(k));
    const onlyInDatabaseForeignKeys = [...dFk.keys()].filter((k) => !eFk.has(k));
    const foreignKeyMismatches: NonNullable<
      SchemaMetaDiffV2["tables"][string]["foreignKeyMismatches"]
    > = [];
    for (const [nm, ef] of eFk) {
      const df = dFk.get(nm);
      if (!df) continue;
      const eRef = `${ef.refSchema}.${ef.refTable}.${ef.refColumn}`;
      const dRef = `${df.refSchema}.${df.refTable}.${df.refColumn}`;
      if (eRef !== dRef || ef.onDelete !== df.onDelete || ef.onUpdate !== df.onUpdate) {
        foreignKeyMismatches.push({
          name: nm,
          entityRef: eRef,
          databaseRef: dRef,
          entityOnDelete: ef.onDelete ?? null,
          databaseOnDelete: df.onDelete ?? null,
        });
      }
    }

    if (
      onlyInEntityColumns.length ||
      onlyInDatabaseColumns.length ||
      renameHeuristic.likelyRenames.length ||
      renameHeuristic.ambiguities.length ||
      typeMismatches.length ||
      nullabilityMismatches.length ||
      onlyInEntityIndexes.length ||
      indexMismatches.length ||
      onlyInEntityForeignKeys.length ||
      foreignKeyMismatches.length
    ) {
      tables[key] = {
        onlyInEntityColumns,
        onlyInDatabaseColumns,
        likelyRenames: renameHeuristic.likelyRenames,
        ...(renameHeuristic.userReviewRequired
          ? {
              renameHeuristicUserReviewRequired: true,
              renameHeuristicAmbiguities: renameHeuristic.ambiguities,
            }
          : {}),
        typeMismatches,
        nullabilityMismatches,
        onlyInEntityIndexes,
        onlyInDatabaseIndexes,
        indexMismatches,
        onlyInEntityForeignKeys,
        onlyInDatabaseForeignKeys,
        foreignKeyMismatches,
      };
    }
  }

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    onlyInEntityTables,
    onlyInDatabaseTables,
    ...(anyRenameHeuristicReview
      ? {
          renameHeuristicUserReviewRequired: true,
          renameHeuristicAgentInstruction: RENAME_HEURISTIC_AGENT_INSTRUCTION,
        }
      : {}),
    tables,
  };
}
