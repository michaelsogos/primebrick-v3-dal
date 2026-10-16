/**
 * Schema-diff: canonical entity-vs-database snapshot machinery.
 * Generation side of the migration engine (migrations/ is the apply side).
 */
export type { SchemaColumnMeta, SchemaSnapshot, SchemaTableMeta } from "./schema-types.js";
export { tableKey } from "./schema-types.js";
export { comparablePgType, typesCompatibleForRename } from "./schema-type-normalize.js";
export {
  findLikelyRenames,
  classifyRenamePair,
  RENAME_MATCH_RULE_LABELS,
  RENAME_HEURISTIC_AGENT_INSTRUCTION,
  type LikelyRename,
  type RenameAmbiguity,
  type RenameHeuristicResult,
} from "./schema-rename-heuristics.js";
export {
  compareSnapshots,
  type SchemaMetaDiffV2,
  type SchemaMetaDiffV1,
} from "./schema-snapshot.js";
export { buildEntitySnapshot, collectEntityTypeWarnings } from "./build-entity-snapshot.js";
export { buildDatabaseSnapshot, type SnapshotQueryable } from "./build-database-snapshot.js";
export {
  utcTimestampForFilename,
  slugifyPatchSegment,
  patchSlugFromDiff,
  buildPatchFilename,
  patchNameFromFilename,
  sha256Hex,
  normalizePatchEol,
} from "./patch-naming.js";
export { buildSqlPatchFromMetaDiff } from "./emit-sql-patch.js";
